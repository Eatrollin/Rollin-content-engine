require('dotenv').config();

const fse    = require('fs-extra');
const path   = require('path');
const os     = require('os');
const logger = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const APPROVAL_HISTORY_PATH = path.join(__dirname, '..', 'data', 'approval-history.json');
const MAX_APPROVALS_PER_DAY = 12;

// Read dynamically so tests and env changes are picked up at call time
function getOutputsBase() {
  return process.env.OUTPUTS_PATH || path.join(os.homedir(), 'Desktop', 'rollin-outputs');
}
const TIERS                 = ['high', 'medium', 'low'];

// ─── Load / save approval history ────────────────────────────────────────────
async function loadHistory() {
  try {
    return await fse.readJson(APPROVAL_HISTORY_PATH);
  } catch {
    return { decisions: [] };
  }
}

async function saveHistory(history) {
  await fse.ensureDir(path.dirname(APPROVAL_HISTORY_PATH));
  await fse.writeJson(APPROVAL_HISTORY_PATH, history, { spaces: 2 });
}

// ─── Find a recommendation JSON file by ID ────────────────────────────────────
// Searches across all tier folders for the given date.
// Returns { filePath, data } or null if not found.
async function findRecFile(recId, date, tier) {
  const dateDirBase = path.join(getOutputsBase(), date);
  const searchTiers = tier ? [tier] : TIERS;

  for (const t of searchTiers) {
    const tierDir = path.join(dateDirBase, t);
    const exists  = await fse.pathExists(tierDir);
    if (!exists) continue;

    const files = await fse.readdir(tierDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(tierDir, file);
      try {
        const data = await fse.readJson(filePath);
        if (data.id === recId) return { filePath, data, tier: t };
      } catch {
        // skip unreadable files
      }
    }
  }
  return null;
}

// ─── Get today's approval count ───────────────────────────────────────────────
async function getApprovalCount(date) {
  const history = await loadHistory();
  return history.decisions.filter(
    (d) => d.date === date && d.decision === 'approved'
  ).length;
}

// ─── Get production queue for a given date ────────────────────────────────────
// Returns all approved recommendations for the day, sorted by rank.
async function getProductionQueue(date) {
  const history   = await loadHistory();
  const approved  = history.decisions.filter(
    (d) => d.date === date && d.decision === 'approved'
  );

  // Enrich with the current rec file data
  const queue = [];
  for (const decision of approved) {
    const found = await findRecFile(decision.recommendationId, date, decision.tier);
    if (found) queue.push({ ...found.data, approvalDecision: decision });
  }

  return queue.sort((a, b) => (a.rank || 99) - (b.rank || 99));
}

// ─── Get full approval history ────────────────────────────────────────────────
async function getApprovalHistory() {
  return loadHistory();
}

// ─── APPROVE ─────────────────────────────────────────────────────────────────
async function approve(recId, date, tier) {
  logger.info(`[Approval] APPROVE requested — rec: ${recId}  date: ${date}  tier: ${tier || 'auto'}`);

  // ── 1. Daily cap check ───────────────────────────────────────────────────
  const todayCount = await getApprovalCount(date);
  if (todayCount >= MAX_APPROVALS_PER_DAY) {
    const msg = `Daily approval cap reached (${MAX_APPROVALS_PER_DAY}/day). Cannot approve more today.`;
    logger.warn(`[Approval] ${msg}`);
    return { success: false, error: msg, capReached: true, count: todayCount };
  }

  // ── 2. Find the recommendation file ──────────────────────────────────────
  const found = await findRecFile(recId, date, tier);
  if (!found) {
    const msg = `Recommendation ${recId} not found for date ${date}`;
    logger.error(`[Approval] ${msg}`);
    return { success: false, error: msg };
  }

  // ── 3. Check not already decided ─────────────────────────────────────────
  if (found.data.approved) {
    logger.warn(`[Approval] ${recId} already approved — skipping duplicate.`);
    return { success: false, error: 'Already approved.', alreadyApproved: true };
  }

  // ── 4. Update the recommendation file ────────────────────────────────────
  const approvedAt = new Date().toISOString();
  found.data.approved   = true;
  found.data.rejected   = false;
  found.data.approvedAt = approvedAt;
  found.data.approvalStatus = 'approved';
  await fse.writeJson(found.filePath, found.data, { spaces: 2 });
  logger.info(`[Approval] ✓ Rec file updated: ${path.basename(found.filePath)}`);

  // ── 5. Write to approval-history.json ────────────────────────────────────
  const history = await loadHistory();
  const decision = {
    id:                  `decision_${Date.now()}`,
    decision:            'approved',
    recommendationId:    recId,
    recommendationTitle: found.data.title      || '',
    tier:                found.tier,
    confidenceScore:     found.data.confidenceScore || null,
    label:               found.data.label      || '',
    date,
    approvedAt,
    rejectedAt:          null,
    note:                '',
    postUrl:             null,   // filled in later when the post goes live
    caption:             found.data.contentBrief?.sampleCaption || '',
    hashtagSet:          found.data.contentBrief?.hashtagSet    || [],
    sourceTrendId:       found.data.sourceTrendId || '',
  };
  history.decisions.push(decision);
  await saveHistory(history);

  const newCount = todayCount + 1;
  logger.info(
    `[Approval] ✓ Approved: "${found.data.title}" ` +
    `[${found.tier.toUpperCase()}] — ${newCount}/${MAX_APPROVALS_PER_DAY} today`
  );

  return {
    success:    true,
    decision,
    approvedAt,
    dailyCount: newCount,
    remaining:  MAX_APPROVALS_PER_DAY - newCount,
  };
}

// ─── REJECT ──────────────────────────────────────────────────────────────────
async function reject(recId, date, tier, note = '') {
  logger.info(`[Approval] REJECT requested — rec: ${recId}  date: ${date}  tier: ${tier || 'auto'}`);
  if (note) logger.info(`[Approval]   Note: "${note}"`);

  // ── 1. Find the recommendation file ──────────────────────────────────────
  const found = await findRecFile(recId, date, tier);
  if (!found) {
    const msg = `Recommendation ${recId} not found for date ${date}`;
    logger.error(`[Approval] ${msg}`);
    return { success: false, error: msg };
  }

  // ── 2. Check not already decided ─────────────────────────────────────────
  if (found.data.rejected) {
    logger.warn(`[Approval] ${recId} already rejected — skipping duplicate.`);
    return { success: false, error: 'Already rejected.', alreadyRejected: true };
  }

  // ── 3. Update the recommendation file ────────────────────────────────────
  const rejectedAt = new Date().toISOString();
  found.data.rejected         = true;
  found.data.approved         = false;
  found.data.rejectedAt       = rejectedAt;
  found.data.rejectionNote    = note || 'No reason given.';
  found.data.approvalStatus   = 'rejected';
  await fse.writeJson(found.filePath, found.data, { spaces: 2 });
  logger.info(`[Approval] ✗ Rec file updated: ${path.basename(found.filePath)}`);

  // ── 4. Write to approval-history.json ────────────────────────────────────
  const history = await loadHistory();

  // Build a rejection pattern note for Claude to learn from
  const patternNote = note
    ? `REJECTED — ${note}`
    : `REJECTED — style/format not approved for @eatrollin. ` +
      `Trend: "${found.data.trendSummary?.slice(0, 100) || found.data.title}". ` +
      `Avoid recommending similar content.`;

  const decision = {
    id:                  `decision_${Date.now()}`,
    decision:            'rejected',
    recommendationId:    recId,
    recommendationTitle: found.data.title      || '',
    tier:                found.tier,
    confidenceScore:     found.data.confidenceScore || null,
    label:               found.data.label      || '',
    date,
    approvedAt:          null,
    rejectedAt,
    note:                patternNote,
    caption:             found.data.contentBrief?.sampleCaption || '',
    hashtagSet:          found.data.contentBrief?.hashtagSet    || [],
    sourceTrendId:       found.data.sourceTrendId || '',
    // These fields are read by the learning loop and passed to Claude
    rejectionPattern: {
      title:          found.data.title,
      tier:           found.tier,
      label:          found.data.label,
      trendSummary:   found.data.trendSummary?.slice(0, 200) || '',
      contentFormat:  found.data.higgsfieldBrief?.styleDirection || '',
      hashtags:       found.data.contentBrief?.hashtagSet || [],
      reason:         note || 'Not specified',
    },
  };

  history.decisions.push(decision);
  await saveHistory(history);

  logger.info(
    `[Approval] ✗ Rejected: "${found.data.title}" ` +
    `[${found.tier.toUpperCase()}] — pattern logged for Claude learning`
  );

  return {
    success:    true,
    decision,
    rejectedAt,
    patternNote,
  };
}

// ─── Get today's decision summary ─────────────────────────────────────────────
async function getDailySummary(date) {
  const history   = await loadHistory();
  const today     = history.decisions.filter((d) => d.date === date);
  const approved  = today.filter((d) => d.decision === 'approved');
  const rejected  = today.filter((d) => d.decision === 'rejected');

  return {
    date,
    totalDecisions: today.length,
    approved:       approved.length,
    rejected:       rejected.length,
    remaining:      MAX_APPROVALS_PER_DAY - approved.length,
    capReached:     approved.length >= MAX_APPROVALS_PER_DAY,
    approvedItems:  approved.map((d) => ({
      id:    d.recommendationId,
      title: d.recommendationTitle,
      tier:  d.tier,
      at:    d.approvedAt,
    })),
    rejectedItems:  rejected.map((d) => ({
      id:    d.recommendationId,
      title: d.recommendationTitle,
      tier:  d.tier,
      note:  d.note,
      at:    d.rejectedAt,
    })),
  };
}

module.exports = {
  approve,
  reject,
  getApprovalCount,
  getProductionQueue,
  getApprovalHistory,
  getDailySummary,
  MAX_APPROVALS_PER_DAY,
};
