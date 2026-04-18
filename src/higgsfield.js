require('dotenv').config();

const axios  = require('axios');
const fse    = require('fs-extra');
const path   = require('path');
const os     = require('os');
const logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const HIGGSFIELD_BASE_URL = 'https://api.cloud.higgsfield.ai';
const ENDPOINT_STATUS     = '/v1/video/status';
const REQUEST_TIMEOUT_MS  = 30_000;

// How many top High-tier recs to generate prompts for per day
const AUTO_SUBMIT_COUNT = 2;

const CONTENT_LIB = process.env.CONTENT_LIBRARY_PATH ||
                    path.join(os.homedir(), 'Desktop', 'rollin-content');

// ─── Generate and save Higgsfield prompt object for one rec ──────────────────
async function generatePrompt(rec) {
  const brief = rec.higgsfieldBrief || {};

  const higgsfieldPrompt = {
    mode: 'manual',
    generatedAt: new Date().toISOString(),
    copyablePrompt: `${brief.sceneDescription}\n\nStyle: ${brief.styleDirection}\nMood: ${brief.mood}\nDuration: ${brief.durationSeconds}s\nAudio: ${brief.audioDirection}`,
    fields: {
      prompt:         brief.sceneDescription || '',
      style:          brief.styleDirection   || 'cinematic',
      mood:           brief.mood             || 'dark',
      duration:       brief.durationSeconds  || 15,
      audioDirection: brief.audioDirection   || 'minimal ambient',
    },
    context: {
      hook:          rec.contentBrief?.hook          || '',
      sampleCaption: rec.contentBrief?.sampleCaption || '',
      hashtags:      rec.contentBrief?.hashtagSet    || [],
      whyItWillWork: rec.whyItWillWork               || '',
    },
  };

  if (rec.savedPaths?.json) {
    try {
      const existing = await fse.readJson(rec.savedPaths.json).catch(() => rec);
      existing.higgsfieldPrompt = higgsfieldPrompt;
      await fse.writeJson(rec.savedPaths.json, existing, { spaces: 2 });
      logger.info(`[Higgsfield]   ↳ Prompt saved to: ${path.basename(rec.savedPaths.json)}`);
    } catch (err) {
      logger.error(`[Higgsfield]   ↳ Failed to save prompt: ${err.message}`);
    }
  }

  return higgsfieldPrompt;
}

// ─── Save a ready-to-paste manual submission file ────────────────────────────
async function saveManualSubmitFile(rec) {
  if (!rec.savedPaths?.json) return null;

  const brief      = rec.higgsfieldBrief || {};
  const outputPath = rec.savedPaths.json.replace(/\.json$/, '_higgsfield_manual.txt');

  const lines = [
    `HIGGSFIELD MANUAL SUBMISSION`,
    `═══════════════════════════════════════════════════════════════`,
    `Generated: ${new Date().toISOString()}`,
    `Rec #${rec.rank}  |  Tier: ${(rec.tier || '').toUpperCase()}  |  Confidence: ${rec.confidenceScore}/10  |  ${rec.label}`,
    ``,
    `TITLE`,
    `───────────────────────────────────────────────────────────────`,
    rec.title || '',
    ``,
    `SCENE DESCRIPTION  ← paste this into Higgsfield "Prompt" field`,
    `───────────────────────────────────────────────────────────────`,
    brief.sceneDescription || rec.trendSummary || '',
    ``,
    `STYLE DIRECTION`,
    `───────────────────────────────────────────────────────────────`,
    brief.styleDirection || 'cinematic',
    ``,
    `MOOD`,
    `───────────────────────────────────────────────────────────────`,
    brief.mood || 'dark',
    ``,
    `DURATION`,
    `───────────────────────────────────────────────────────────────`,
    `${brief.durationSeconds || 15} seconds`,
    ``,
    `AUDIO DIRECTION`,
    `───────────────────────────────────────────────────────────────`,
    brief.audioDirection || 'minimal ambient',
    ``,
    `═══════════════════════════════════════════════════════════════`,
    `CONTENT CONTEXT  (reference only — do not paste into Higgsfield)`,
    `═══════════════════════════════════════════════════════════════`,
    ``,
    `Hook:`,
    rec.contentBrief?.hook || '',
    ``,
    `Why it will work:`,
    rec.whyItWillWork || '',
    ``,
    `Sample caption:`,
    rec.contentBrief?.sampleCaption || '',
    ``,
    `Hashtags:`,
    (rec.contentBrief?.hashtagSet || []).join(' '),
    ``,
    `Trend summary:`,
    rec.trendSummary || '',
  ];

  try {
    await fse.writeFile(outputPath, lines.join('\n'), 'utf8');
    logger.info(`[Higgsfield]   ↳ Manual submit file saved: ${path.basename(outputPath)}`);
    return outputPath;
  } catch (err) {
    logger.error(`[Higgsfield]   ↳ Failed to save manual submit file: ${err.message}`);
    return null;
  }
}

// ─── Poll for render status (dashboard on-demand, not blocking) ───────────────
async function checkJobStatus(jobId) {
  if (!jobId) return { status: 'unknown', jobId };

  try {
    const response = await axios.get(
      `${HIGGSFIELD_BASE_URL}${ENDPOINT_STATUS}/${jobId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.HIGGSFIELD_API_KEY}`,
          'User-Agent':  'RollinContentEngine/1.0',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    const data = response.data || {};
    return {
      jobId,
      status:     data.status    || 'unknown',
      renderLink: data.video_url || data.url || data.render_url || null,
      progress:   data.progress  || null,
      rawResponse: data,
    };
  } catch (err) {
    logger.error(`[Higgsfield] Status check failed for job ${jobId}: ${err.message}`);
    return { jobId, status: 'error', error: err.message };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(recommendations) {
  logger.info('[Higgsfield] ─────────────────────────────────────────────');
  logger.info('[Higgsfield] PROMPT-ONLY MODE — generating copyable prompts');
  logger.info(`[Higgsfield] Processing top ${AUTO_SUBMIT_COUNT} High-tier recs`);
  logger.info('[Higgsfield] ─────────────────────────────────────────────');

  if (!recommendations || recommendations.length === 0) {
    logger.warn('[Higgsfield] No recommendations — skipping.');
    return [];
  }

  const highTier = recommendations
    .filter((r) => r.tier === 'high')
    .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0))
    .slice(0, AUTO_SUBMIT_COUNT);

  if (highTier.length === 0) {
    logger.warn('[Higgsfield] No High-tier recommendations found — skipping.');
    return [];
  }

  logger.info(`[Higgsfield] Generating prompts for ${highTier.length} recommendation(s):`);
  highTier.forEach((r) =>
    logger.info(`[Higgsfield]   • #${r.rank} "${r.title}" — ${r.confidenceScore}/10`)
  );

  const results = [];

  for (const rec of highTier) {
    const higgsfieldPrompt = await generatePrompt(rec);
    await saveManualSubmitFile(rec);

    results.push({
      recommendationId:    rec.id,
      recommendationTitle: rec.title,
      recommendationRank:  rec.rank,
      confidenceScore:     rec.confidenceScore,
      mode:                'manual',
      generatedAt:         higgsfieldPrompt.generatedAt,
    });
  }

  logger.info('[Higgsfield] ─────────────────────────────────────────────');
  logger.info(`[Higgsfield] Generated ${results.length} prompt(s) — copy from dashboard`);
  logger.info('[Higgsfield] ─────────────────────────────────────────────');

  return results;
}

module.exports = { run, checkJobStatus, AUTO_SUBMIT_COUNT, HIGGSFIELD_BASE_URL };
