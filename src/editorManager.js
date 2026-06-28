require('dotenv').config();

const fse    = require('fs-extra');
const path   = require('path');
const logger = require('./logger');
const { DATA_DIR } = require('./config');

// ─── Config ───────────────────────────────────────────────────────────────────
const STORE_PATH = path.join(DATA_DIR, 'editor-sends.json');

const emptyStore = () => ({ knownEmails: [], sends: [] });

// ─── Load / save store ────────────────────────────────────────────────────────
async function loadStore() {
  try {
    return await fse.readJson(STORE_PATH);
  } catch {
    return emptyStore();
  }
}

async function saveStore(store) {
  await fse.ensureDir(path.dirname(STORE_PATH));
  await fse.writeJson(STORE_PATH, store, { spaces: 2 });
}

// ─── getKnownEmails ───────────────────────────────────────────────────────────
async function getKnownEmails() {
  const store = await loadStore();
  return store.knownEmails || [];
}

// ─── getSendsForRec ───────────────────────────────────────────────────────────
async function getSendsForRec(recId) {
  const store = await loadStore();
  return (store.sends || [])
    .filter(s => s.recId === recId)
    .slice()
    .reverse(); // newest first
}

// ─── getAllSends ──────────────────────────────────────────────────────────────
async function getAllSends() {
  const store = await loadStore();
  return store.sends || [];
}

// ─── recordSend ───────────────────────────────────────────────────────────────
async function recordSend({ recId, date, tier, title, editorEmail, resendId }) {
  logger.info(`[EditorManager] Recording send — rec: ${recId}  to: ${editorEmail}`);
  try {
    const store  = await loadStore();
    const sentAt = new Date().toISOString();

    const send = { recId, date, tier, title, editorEmail, sentAt, resendId: resendId || null };
    store.sends.push(send);

    // Case-insensitive dedupe; keep first-seen casing
    const emailLower = editorEmail.toLowerCase();
    const already    = store.knownEmails.some(e => e.toLowerCase() === emailLower);
    if (!already) store.knownEmails.push(editorEmail);

    await saveStore(store);
    logger.info(`[EditorManager] ✓ Send recorded: ${recId} → ${editorEmail}`);
    return { success: true, send };
  } catch (err) {
    logger.error(`[EditorManager] Error recording send: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { getKnownEmails, getSendsForRec, getAllSends, recordSend };
