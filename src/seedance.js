require('dotenv').config();

const fse    = require('fs-extra');
const logger = require('./logger');

const IMAGE_TO_VIDEO = 'fal-ai/seedance-v1-lite/image-to-video';
const TEXT_TO_VIDEO  = 'fal-ai/seedance-v1-lite';

function getFal() {
  const { fal } = require('@fal-ai/client');
  fal.config({ credentials: process.env.FAL_API_KEY });
  return fal;
}

async function submitOne(fal, rec, footageLibrary) {
  const match = rec.footageMatch;
  if (!match || match.type !== 'seedance-ready') return null;

  // Find image files first (preferred for image-to-video), then any video
  const matchedObjs = (match.matchedFiles || [])
    .map(name => footageLibrary.find(f => f.name === name || `${f.name} [${f.folderName}]` === name))
    .filter(Boolean);

  const imageFile = matchedObjs.find(f => f.isImage && f.webContentLink);
  const videoFile = !imageFile && matchedObjs.find(f => f.isVideo && f.webContentLink);

  let requestId;

  if (imageFile) {
    logger.info(`[Seedance] ${rec.id} — image-to-video using "${imageFile.name}"`);
    const sub = await fal.queue.submit(IMAGE_TO_VIDEO, {
      input: {
        image_url: imageFile.webContentLink,
        prompt:    match.seedancePrompt,
      },
    });
    requestId = sub.request_id;
  } else if (videoFile) {
    logger.info(`[Seedance] ${rec.id} — image-to-video using video thumbnail from "${videoFile.name}"`);
    const sub = await fal.queue.submit(IMAGE_TO_VIDEO, {
      input: {
        image_url: videoFile.webContentLink,
        prompt:    match.seedancePrompt,
      },
    });
    requestId = sub.request_id;
  } else {
    logger.info(`[Seedance] ${rec.id} — text-to-video (no usable Drive URL found)`);
    const sub = await fal.queue.submit(TEXT_TO_VIDEO, {
      input: { prompt: match.seedancePrompt },
    });
    requestId = sub.request_id;
  }

  return {
    recId:       rec.id,
    title:       rec.title,
    requestId:   requestId || null,
    status:      'submitted',
    videoUrl:    null,
    submittedAt: new Date().toISOString(),
    model:       imageFile || videoFile ? IMAGE_TO_VIDEO : TEXT_TO_VIDEO,
  };
}

async function run(recommendations, footageLibrary = []) {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    logger.warn('[Seedance] FAL_API_KEY not set — skipping Seedance submissions.');
    return [];
  }

  const seedanceRecs = (recommendations || []).filter(r => r.footageMatch?.type === 'seedance-ready');
  if (!seedanceRecs.length) {
    logger.info('[Seedance] No seedance-ready recommendations — nothing to submit.');
    return [];
  }

  logger.info(`[Seedance] Submitting ${seedanceRecs.length} job(s) to fal.ai...`);

  let fal;
  try {
    fal = getFal();
  } catch (err) {
    logger.error(`[Seedance] Could not load @fal-ai/client: ${err.message}`);
    return [];
  }

  const jobs = [];

  for (const rec of seedanceRecs) {
    try {
      const job = await submitOne(fal, rec, footageLibrary);
      if (!job) continue;

      // Persist to rec JSON file
      if (rec.savedPaths?.json) {
        try {
          const existing   = await fse.readJson(rec.savedPaths.json);
          existing.seedance = job;
          await fse.writeJson(rec.savedPaths.json, existing, { spaces: 2 });
        } catch (writeErr) {
          logger.warn(`[Seedance] Could not update disk file for ${rec.id}: ${writeErr.message}`);
        }
      }

      rec.seedance = job;
      logger.info(`[Seedance]  ${rec.id} → request_id: ${job.requestId || 'N/A'}`);
      jobs.push(job);
    } catch (err) {
      logger.error(`[Seedance] Failed for ${rec.id}: ${err.message}`);
    }
  }

  logger.info(`[Seedance] ${jobs.length} job(s) submitted.`);
  return jobs;
}

module.exports = { run };
