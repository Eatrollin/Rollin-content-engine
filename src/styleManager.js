require('dotenv').config();

const path   = require('path');
const fse    = require('fs-extra');
const logger = require('./logger');
const { DATA_DIR } = require('./config');

const STYLE_FILE = path.join(DATA_DIR, 'style-learning.json');

async function loadStyleLearning() {
  try { return await fse.readJson(STYLE_FILE); }
  catch { return { entries: [] }; }
}

async function saveStyleLearning(data) {
  await fse.ensureDir(path.dirname(STYLE_FILE));
  await fse.writeJson(STYLE_FILE, data, { spaces: 2 });
}

async function recordStyleFeedback(recId, recTitle, type, reason) {
  if (!['positive', 'negative'].includes(type)) {
    return { success: false, error: 'type must be "positive" or "negative"' };
  }
  const data = await loadStyleLearning();
  data.entries.push({
    recId,
    recTitle:    recTitle || '',
    type,
    reason:      reason || '',
    recordedAt:  new Date().toISOString(),
  });
  await saveStyleLearning(data);
  logger.info(`[StyleManager] Recorded ${type} style feedback for "${recTitle}": ${reason || '(no reason)'}`);
  return { success: true };
}

module.exports = { loadStyleLearning, recordStyleFeedback };
