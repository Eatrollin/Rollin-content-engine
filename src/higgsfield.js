require('dotenv').config();

const axios    = require('axios');
const FormData = require('form-data');
const fse      = require('fs-extra');
const path     = require('path');
const os       = require('os');
const logger   = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// HIGGSFIELD API CONFIG
// Update these constants if Higgsfield changes their endpoint paths.
// All API surface is isolated here — nothing is scattered in the logic below.
// ─────────────────────────────────────────────────────────────────────────────
const HIGGSFIELD_BASE_URL    = 'https://api.cloud.higgsfield.ai';
const ENDPOINT_GENERATE      = '/v1/video/generate';        // POST — create job
const ENDPOINT_STATUS        = '/v1/video/status';          // GET  — /{jobId}
const REQUEST_TIMEOUT_MS     = 30_000;

// How many top High-tier recs to auto-submit per day
const AUTO_SUBMIT_COUNT = 2;

// Supported footage extensions for file upload
const FOOTAGE_EXTS = ['.mp4', '.mov', '.m4v'];

const CONTENT_LIB = process.env.CONTENT_LIBRARY_PATH ||
                    path.join(os.homedir(), 'Desktop', 'rollin-content');

// ─── Build Higgsfield request payload ────────────────────────────────────────
function buildPayload(rec) {
  const brief = rec.higgsfieldBrief || {};
  return {
    // Core generation parameters
    prompt:        brief.sceneDescription || rec.trendSummary || '',
    style:         brief.styleDirection   || 'cinematic',
    mood:          brief.mood             || 'dark',
    duration:      brief.durationSeconds  || 15,
    audio_prompt:  brief.audioDirection   || 'minimal ambient',

    // Rollin brand context passed as metadata
    brand: 'Rollin',
    brand_voice: 'dark, clean, modern, bold, chef-driven, premium',
    reference_note: rec.rawFootageNote || '',

    // Internal tracking
    recommendation_id:    rec.id,
    recommendation_title: rec.title,
    confidence_score:     rec.confidenceScore,
    label:                rec.label,
  };
}

// ─── Find matching footage file for this recommendation ───────────────────────
async function findFootage(rec) {
  try {
    const libExists = await fse.pathExists(CONTENT_LIB);
    if (!libExists) return null;

    const files = await fse.readdir(CONTENT_LIB);
    const videoFiles = files.filter((f) =>
      FOOTAGE_EXTS.includes(path.extname(f).toLowerCase())
    );
    if (videoFiles.length === 0) return null;

    // Try to match on rec keywords
    const keywords = [
      ...(rec.contentBrief?.hashtagSet || []),
      ...(rec.title || '').toLowerCase().split(/\s+/),
    ].map((k) => k.toLowerCase()).filter(Boolean);

    const matched = videoFiles.find((f) =>
      keywords.some((k) => f.toLowerCase().includes(k))
    );

    return matched ? path.join(CONTENT_LIB, matched) : null;
  } catch {
    return null;
  }
}

// ─── Submit one recommendation to Higgsfield ─────────────────────────────────
async function submitOne(rec) {
  const payload    = buildPayload(rec);
  const footagePath = await findFootage(rec);
  const hasFootage = !!footagePath;

  logger.info(`[Higgsfield] Submitting #${rec.rank} "${rec.title}" (confidence ${rec.confidenceScore}/10)`);
  if (hasFootage) {
    logger.info(`[Higgsfield]   ↳ Including footage: ${path.basename(footagePath)}`);
  } else {
    logger.info(`[Higgsfield]   ↳ No matching footage — text-to-video generation`);
  }

  const headers = {
    Authorization: `Bearer ${process.env.HIGGSFIELD_API_KEY}`,
    'User-Agent':  'RollinContentEngine/1.0',
  };

  let response;

  try {
    if (hasFootage) {
      // ── Multipart — include footage file ──────────────────────────────────
      const form = new FormData();
      form.append('data', JSON.stringify(payload), { contentType: 'application/json' });
      form.append('footage', fse.createReadStream(footagePath), {
        filename:    path.basename(footagePath),
        contentType: 'video/mp4',
      });

      response = await axios.post(
        `${HIGGSFIELD_BASE_URL}${ENDPOINT_GENERATE}`,
        form,
        {
          headers:         { ...headers, ...form.getHeaders() },
          timeout:         REQUEST_TIMEOUT_MS,
          maxBodyLength:   250 * 1024 * 1024, // 250MB max upload
          maxContentLength: 250 * 1024 * 1024,
        }
      );
    } else {
      // ── JSON only — text-to-video ─────────────────────────────────────────
      response = await axios.post(
        `${HIGGSFIELD_BASE_URL}${ENDPOINT_GENERATE}`,
        payload,
        { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: REQUEST_TIMEOUT_MS }
      );
    }

    const data   = response.data || {};
    const jobId  = data.id || data.job_id || data.jobId || data.task_id || null;
    const status = data.status || 'submitted';
    const renderLink = data.video_url || data.url || data.render_url || null;

    logger.info(`[Higgsfield]   ✓ Submitted — Job ID: ${jobId}  Status: ${status}`);
    if (renderLink) logger.info(`[Higgsfield]   ✓ Render link: ${renderLink}`);

    return {
      success:      true,
      jobId,
      status,
      renderLink,
      submittedAt:  new Date().toISOString(),
      footageUsed:  hasFootage ? path.basename(footagePath) : null,
      payload,
      rawResponse:  data,
    };

  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    logger.error(`[Higgsfield]   ✗ Submission failed for "${rec.title}": ${err.message}`);
    if (status)  logger.error(`[Higgsfield]     HTTP ${status}: ${JSON.stringify(body)}`);

    return {
      success:     false,
      jobId:       null,
      status:      'failed',
      renderLink:  null,
      error:       err.message,
      httpStatus:  status || null,
      httpBody:    body   || null,
      submittedAt: new Date().toISOString(),
      footageUsed: null,
      payload,
    };
  }
}

// ─── Update the saved recommendation JSON with Higgsfield job info ────────────
async function updateRecFile(rec, jobResult) {
  if (!rec.savedPaths?.json) return;

  try {
    const existing = await fse.readJson(rec.savedPaths.json).catch(() => rec);
    existing.higgsfield = jobResult;
    await fse.writeJson(rec.savedPaths.json, existing, { spaces: 2 });
    logger.info(`[Higgsfield]   ↳ Rec file updated: ${path.basename(rec.savedPaths.json)}`);
  } catch (err) {
    logger.error(`[Higgsfield]   ↳ Failed to update rec file: ${err.message}`);
  }
}

// ─── Poll for render status (called by dashboard on demand, not blocking) ─────
// Call this separately after submission to check if a job has completed.
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
      status:     data.status     || 'unknown',
      renderLink: data.video_url  || data.url || data.render_url || null,
      progress:   data.progress   || null,
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
  logger.info('[Higgsfield] Auto-submitting top High-tier recommendations');
  logger.info(`[Higgsfield] Submit count: ${AUTO_SUBMIT_COUNT}`);
  logger.info(`[Higgsfield] Endpoint: ${HIGGSFIELD_BASE_URL}${ENDPOINT_GENERATE}`);
  logger.info('[Higgsfield] ─────────────────────────────────────────────');

  if (!recommendations || recommendations.length === 0) {
    logger.warn('[Higgsfield] No recommendations — skipping.');
    return [];
  }

  if (!process.env.HIGGSFIELD_API_KEY) {
    logger.error('[Higgsfield] HIGGSFIELD_API_KEY not set — skipping submission.');
    return [];
  }

  // ── Select top N High-tier recs sorted by confidence ─────────────────────
  const highTier = recommendations
    .filter((r) => r.tier === 'high')
    .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0))
    .slice(0, AUTO_SUBMIT_COUNT);

  if (highTier.length === 0) {
    logger.warn('[Higgsfield] No High-tier recommendations found — skipping.');
    return [];
  }

  logger.info(`[Higgsfield] Submitting ${highTier.length} recommendation(s):`);
  highTier.forEach((r) =>
    logger.info(`[Higgsfield]   • #${r.rank} "${r.title}" — ${r.confidenceScore}/10`)
  );

  // ── Submit each sequentially (avoid parallel upload bandwidth issues) ─────
  const jobs = [];

  for (const rec of highTier) {
    const result = await submitOne(rec);
    await updateRecFile(rec, result);

    jobs.push({
      recommendationId:    rec.id,
      recommendationTitle: rec.title,
      recommendationRank:  rec.rank,
      confidenceScore:     rec.confidenceScore,
      ...result,
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const succeeded = jobs.filter((j) => j.success).length;
  const failed    = jobs.filter((j) => !j.success).length;

  logger.info('[Higgsfield] ─────────────────────────────────────────────');
  logger.info(`[Higgsfield] Submitted: ${succeeded} success, ${failed} failed`);
  jobs.forEach((j) => {
    const icon = j.success ? '✓' : '✗';
    logger.info(
      `[Higgsfield]  ${icon} "${j.recommendationTitle}" — ` +
      `Job: ${j.jobId || 'n/a'}  Status: ${j.status}`
    );
    if (j.renderLink) logger.info(`[Higgsfield]    Link: ${j.renderLink}`);
    if (!j.success)   logger.error(`[Higgsfield]    Error: ${j.error}`);
  });
  logger.info('[Higgsfield] ─────────────────────────────────────────────');

  return jobs;
}

module.exports = { run, checkJobStatus, AUTO_SUBMIT_COUNT, HIGGSFIELD_BASE_URL };
