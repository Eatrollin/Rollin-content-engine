require('dotenv').config();

const { OpenAI, toFile } = require('openai');
const axios  = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const path   = require('path');
const fse    = require('fs-extra');
const os     = require('os');
const logger = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const WHISPER_MODEL      = 'whisper-1';
const MAX_FILE_BYTES     = 24 * 1024 * 1024;   // 24MB — Whisper hard limit is 25MB
const DOWNLOAD_TIMEOUT   = 60_000;              // 60s to download a video
const TRANSCRIBE_TIMEOUT = 120_000;             // 120s for Whisper to respond
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

// ─── Extract audio from video to mp3 ─────────────────────────────────────────
function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .on('end', resolve)
      .on('error', reject)
      .save(audioPath);
  });
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

  let tmpPath   = null;
  let audioPath = null;

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

    // ── 2.5. Extract audio to mp3 ────────────────────────────────────────────
    audioPath = tmpPath.replace('.mp4', '.mp3');
    logger.info(`[Transcriber] Extracting audio from ${sizeMB}MB video...`);
    await extractAudio(tmpPath, audioPath);
    const { size: audioSize } = await fse.stat(audioPath);
    const audioMB = (audioSize / 1024 / 1024).toFixed(1);
    logger.info(`[Transcriber] Audio extracted — ${audioMB}MB mp3 — sending to Whisper...`);

    // ── 3. Send to Whisper (with retry on connection errors) ────────────────
    const fileBuffer = await fse.readFile(audioPath);
    const audioFile  = await toFile(fileBuffer, 'audio.mp3', { type: 'audio/mpeg' });

    const RETRY_DELAYS    = [2000, 5000, 10000];
    const RETRYABLE_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'];

    function isRetryable(err) {
      if (RETRYABLE_CODES.includes(err.code)) return true;
      if (err.message && err.message.includes('socket hang up')) return true;
      return false;
    }

    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT);
      try {
        result = await getOpenAI().audio.transcriptions.create(
          { file: audioFile, model: WHISPER_MODEL, response_format: 'json' },
          { signal: controller.signal }
        );
        clearTimeout(timer);
        break;
      } catch (err) {
        clearTimeout(timer);
        if (!isRetryable(err) || attempt === 3) throw err;
        const delay = RETRY_DELAYS[attempt - 1];
        logger.warn(`[Transcriber] Whisper connection error (attempt ${attempt}/3) — retrying in ${delay / 1000}s: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
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
    // Distinguish download vs extraction vs transcription errors for better logging
    const stage = !tmpPath ? 'download' : !audioPath ? 'audio-extraction' : 'transcription';
    logger.error(
      `[Transcriber] ✗ @${video.accountHandle} — ${stage} failed: ${err.message} | code: ${err.code || 'none'} | status: ${err.status || err.response?.status || 'none'}`
    );
    return { text: null, reason: `${stage}-error`, error: err.message };

  } finally {
    // Always clean up temp files regardless of outcome
    if (tmpPath)   await fse.remove(tmpPath).catch(() => {});
    if (audioPath) await fse.remove(audioPath).catch(() => {});
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
// Processes all above-median videos sequentially (Whisper rate limits are tight).
// Returns a map: { [videoId]: { text, wordCount, platform, accountHandle, ... } }
async function run(scoredVideos) {
  const { execSync } = require('child_process');
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    logger.info('[Transcriber] ffmpeg available ✓');
  } catch {
    logger.warn('[Transcriber] ffmpeg NOT available — will send raw video to Whisper instead');
  }

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
  const MAX_CONSECUTIVE_ERRORS = 5;
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
