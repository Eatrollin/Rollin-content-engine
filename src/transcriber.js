require('dotenv').config();

const { OpenAI, toFile } = require('openai');
const axios  = require('axios');
const path   = require('path');
const fse    = require('fs-extra');
const os     = require('os');
const logger = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const WHISPER_MODEL      = 'whisper-1';
const MAX_FILE_BYTES     = 24 * 1024 * 1024;   // 24MB — Whisper hard limit is 25MB
const DOWNLOAD_TIMEOUT   = 45_000;              // 45s to download a video
const TRANSCRIBE_TIMEOUT = 90_000;              // 90s for Whisper to respond
const DOWNLOAD_HEADERS   = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
};

// ─── OpenAI client (lazy init) ────────────────────────────────────────────────
let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ─── Safe filename ────────────────────────────────────────────────────────────
function safeName(id) {
  return String(id).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
}

// ─── Download video to a temp file ───────────────────────────────────────────
async function downloadToTemp(url, videoId) {
  const tmpPath = path.join(os.tmpdir(), `rollin_${safeName(videoId)}.mp4`);

  const response = await axios({
    method:       'GET',
    url,
    responseType: 'stream',
    timeout:      DOWNLOAD_TIMEOUT,
    headers:      DOWNLOAD_HEADERS,
    maxRedirects: 10,
  });

  await new Promise((resolve, reject) => {
    const writer = fse.createWriteStream(tmpPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });

  return tmpPath;
}

// ─── Transcribe one video ─────────────────────────────────────────────────────
// Returns transcription text string, or null if no speech / failure.
async function transcribeOne(video) {
  const downloadUrl = video.videoDownloadUrl || video.url;

  if (!downloadUrl) {
    logger.warn(`[Transcriber] @${video.accountHandle} (${video.id}) — no download URL, skipping`);
    return { text: null, reason: 'no-url' };
  }

  let tmpPath = null;

  try {
    // ── 1. Download ──────────────────────────────────────────────────────────
    logger.info(`[Transcriber] Downloading @${video.accountHandle} (${video.platform})...`);
    tmpPath = await downloadToTemp(downloadUrl, video.id);

    // ── 2. Check file size ───────────────────────────────────────────────────
    const { size } = await fse.stat(tmpPath);
    const sizeMB = (size / 1024 / 1024).toFixed(1);

    if (size > MAX_FILE_BYTES) {
      logger.warn(
        `[Transcriber] @${video.accountHandle} — ${sizeMB}MB exceeds 24MB limit, skipping`
      );
      return { text: null, reason: 'file-too-large', sizeMB };
    }

    logger.info(`[Transcriber] Downloaded ${sizeMB}MB — sending to Whisper...`);

    // ── 3. Send to Whisper ───────────────────────────────────────────────────
    const fileBuffer = await fse.readFile(tmpPath);
    const audioFile  = await toFile(fileBuffer, 'audio.mp4', { type: 'video/mp4' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT);

    let result;
    try {
      result = await getOpenAI().audio.transcriptions.create(
        { file: audioFile, model: WHISPER_MODEL, response_format: 'json' },
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timer);
    }

    const text = result?.text?.trim() || '';

    if (!text) {
      logger.info(`[Transcriber] @${video.accountHandle} — no spoken audio detected`);
      return { text: null, reason: 'no-speech' };
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    logger.info(
      `[Transcriber] ✓ @${video.accountHandle} — ${wordCount} words transcribed`
    );

    return { text, wordCount, reason: 'success' };

  } catch (err) {
    // Distinguish download vs transcription errors for better logging
    const stage = tmpPath ? 'transcription' : 'download';
    logger.error(
      `[Transcriber] ✗ @${video.accountHandle} — ${stage} failed: ${err.message}`
    );
    return { text: null, reason: `${stage}-error`, error: err.message };

  } finally {
    // Always clean up the temp file regardless of outcome
    if (tmpPath) {
      await fse.remove(tmpPath).catch(() => {});
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
// Processes all above-median videos sequentially (Whisper rate limits are tight).
// Returns a map: { [videoId]: { text, wordCount, platform, accountHandle, ... } }
async function run(scoredVideos) {
  const candidates = scoredVideos.filter((v) => v.kpi?.passedKpiThreshold);

  logger.info(`[Transcriber] ─────────────────────────────────────────────`);
  logger.info(`[Transcriber] ${candidates.length} videos passed KPI threshold — transcribing`);
  logger.info(`[Transcriber] Model: ${WHISPER_MODEL}  |  Max file size: 24MB`);
  logger.info(`[Transcriber] ─────────────────────────────────────────────`);

  if (candidates.length === 0) {
    logger.warn('[Transcriber] No candidates — skipping transcription step.');
    return {};
  }

  const transcriptions = {};
  const stats = { success: 0, noSpeech: 0, tooLarge: 0, noUrl: 0, error: 0 };
  const MAX_CONSECUTIVE_ERRORS = 3;
  let consecutiveErrors = 0;

  // Sequential — avoids hammering Whisper API and keeps temp disk usage low
  for (const video of candidates) {
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      logger.warn(`[Transcriber] ${MAX_CONSECUTIVE_ERRORS} consecutive connection errors — aborting transcription. Claude will work from KPI signals only.`);
      break;
    }

    const result = await transcribeOne(video);

    if (result.text) {
      consecutiveErrors = 0;
      transcriptions[video.id] = {
        videoId:        video.id,
        platform:       video.platform,
        accountHandle:  video.accountHandle,
        url:            video.url,
        text:           result.text,
        wordCount:      result.wordCount,
        transcribedAt:  new Date().toISOString(),
        // Attach KPI context so the analyzer has everything in one place
        kpiScore:       video.kpi.compositeScore,
        kpiSignals:     video.kpi.kpiSignalsMatched,
      };
      stats.success++;
    } else {
      // Track skip reasons
      if (result.reason === 'no-speech')            { stats.noSpeech++; consecutiveErrors = 0; }
      else if (result.reason === 'file-too-large')  { stats.tooLarge++; consecutiveErrors = 0; }
      else if (result.reason === 'no-url')          { stats.noUrl++;    consecutiveErrors = 0; }
      else                                          { stats.error++;    consecutiveErrors++; }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  logger.info(`[Transcriber] ─────────────────────────────────────────────`);
  logger.info(`[Transcriber] Transcription complete:`);
  logger.info(`[Transcriber]   ✓ Transcribed:   ${stats.success}`);
  logger.info(`[Transcriber]   — No speech:     ${stats.noSpeech}`);
  logger.info(`[Transcriber]   — Too large:     ${stats.tooLarge}`);
  logger.info(`[Transcriber]   — No URL:        ${stats.noUrl}`);
  logger.info(`[Transcriber]   ✗ Errors:        ${stats.error}`);
  logger.info(`[Transcriber] ─────────────────────────────────────────────`);

  // Log a preview of each successful transcription
  for (const [id, t] of Object.entries(transcriptions)) {
    const preview = t.text.length > 120 ? t.text.slice(0, 120) + '…' : t.text;
    logger.info(`[Transcriber] @${t.accountHandle}: "${preview}"`);
  }

  return transcriptions;
}

module.exports = { run };
