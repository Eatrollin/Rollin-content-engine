require('dotenv').config();

const { MongoClient } = require('mongodb');
const logger = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const DB_NAME = 'rollin';

let _client         = null;
let _db             = null;
let _connected      = false;
let _connectAttempted = false;

// ─── Connection ───────────────────────────────────────────────────────────────
async function connect() {
  if (_connectAttempted) return _connected;
  _connectAttempted = true;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    logger.warn('[Database] MONGODB_URI not set — MongoDB disabled, using file system only.');
    return false;
  }

  try {
    _client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS:         10000,
    });
    await _client.connect();
    _db = _client.db(DB_NAME);
    _connected = true;
    logger.info('[Database] ✓ Connected to MongoDB.');
    await createIndexes();
    return true;
  } catch (err) {
    logger.error(`[Database] Connection failed: ${err.message} — falling back to file system.`);
    _connected = false;
    return false;
  }
}

// Auto-connect on first use if not already attempted
async function ensureConnected() {
  if (!_connectAttempted) await connect();
  return _connected;
}

function isConnected() { return _connected; }

// ─── Indexes ──────────────────────────────────────────────────────────────────
async function createIndexes() {
  try {
    await _db.collection('recommendations').createIndex(   { recId: 1, date: 1 },       { unique: true });
    await _db.collection('approval_history').createIndex(  { id: 1 },                   { unique: true });
    await _db.collection('performance_history').createIndex({ id: 1, platform: 1 },     { unique: true });
    await _db.collection('pipeline_runs').createIndex(     { date: 1 },                 { unique: true });
    await _db.collection('scraped_videos').createIndex(    { date: 1 },                 { unique: true });
    logger.info('[Database] Indexes verified.');
  } catch (err) {
    logger.warn(`[Database] Index creation warning: ${err.message}`);
  }
}

// ─── Recommendations ──────────────────────────────────────────────────────────
async function saveRecommendations(recs, date) {
  if (!(await ensureConnected())) return false;
  try {
    const ops = recs.map(rec => {
      // Strip local-only fields that are meaningless outside this machine
      const { savedPaths, footage, ...recData } = rec;
      return {
        replaceOne: {
          filter:      { recId: rec.id, date },
          replacement: { recId: rec.id, date, ...recData },
          upsert:      true,
        },
      };
    });
    if (ops.length) await _db.collection('recommendations').bulkWrite(ops);
    logger.info(`[Database] Saved ${recs.length} recommendations (date: ${date}).`);
    return true;
  } catch (err) {
    logger.error(`[Database] saveRecommendations failed: ${err.message}`);
    return false;
  }
}

async function getRecommendations(date) {
  if (!(await ensureConnected())) return null;
  try {
    const docs = await _db.collection('recommendations').find({ date }).sort({ rank: 1 }).toArray();
    return docs.length > 0 ? docs : null;
  } catch (err) {
    logger.error(`[Database] getRecommendations failed: ${err.message}`);
    return null;
  }
}

// ─── Approval History ─────────────────────────────────────────────────────────
async function saveApprovalDecision(decision) {
  if (!(await ensureConnected())) return false;
  try {
    await _db.collection('approval_history').replaceOne(
      { id: decision.id },
      decision,
      { upsert: true }
    );
    return true;
  } catch (err) {
    logger.error(`[Database] saveApprovalDecision failed: ${err.message}`);
    return false;
  }
}

async function getApprovalHistory() {
  if (!(await ensureConnected())) return null;
  try {
    const decisions = await _db.collection('approval_history').find({}).toArray();
    return decisions.length > 0 ? { decisions } : null;
  } catch (err) {
    logger.error(`[Database] getApprovalHistory failed: ${err.message}`);
    return null;
  }
}

// ─── Performance History ──────────────────────────────────────────────────────
async function savePerformancePosts(posts) {
  if (!(await ensureConnected())) return false;
  if (!posts || posts.length === 0) return true;
  try {
    const ops = posts.map(post => ({
      replaceOne: {
        filter:      { id: post.id, platform: post.platform },
        replacement: post,
        upsert:      true,
      },
    }));
    await _db.collection('performance_history').bulkWrite(ops);
    logger.info(`[Database] Saved ${posts.length} performance posts.`);
    return true;
  } catch (err) {
    logger.error(`[Database] savePerformancePosts failed: ${err.message}`);
    return false;
  }
}

async function getPerformanceHistory() {
  if (!(await ensureConnected())) return null;
  try {
    const posts = await _db.collection('performance_history').find({}).toArray();
    return posts.length > 0 ? { posts, updatedAt: new Date().toISOString() } : null;
  } catch (err) {
    logger.error(`[Database] getPerformanceHistory failed: ${err.message}`);
    return null;
  }
}

// ─── Scraped Video Data ───────────────────────────────────────────────────────
// Stores scrape summary stats + KPI-passing videos only (keeps document size lean).
async function saveScrapedData(date, stats, scoredVideos) {
  if (!(await ensureConnected())) return false;
  try {
    const kpiPassedVideos = (scoredVideos || [])
      .filter(v => v.kpi?.passedKpiThreshold)
      .sort((a, b) => (b.kpi?.compositeScore || 0) - (a.kpi?.compositeScore || 0))
      .map(v => ({
        url:               v.url,
        accountHandle:     v.accountHandle,
        platform:          v.platform,
        compositeScore:    v.kpi?.compositeScore  || 0,
        kpiSignalsMatched: v.kpi?.kpiSignalsMatched || [],
        caption:           (v.caption || '').slice(0, 300),
        viewCount:         v.viewCount || 0,
      }));

    await _db.collection('scraped_videos').replaceOne(
      { date },
      {
        date,
        totalVideos:    stats.totalVideos    || 0,
        tiktokCount:    stats.tiktokCount    || 0,
        instagramCount: stats.instagramCount || 0,
        kpiPassedVideos,
        savedAt: new Date().toISOString(),
      },
      { upsert: true }
    );
    logger.info(`[Database] Saved scrape data (date: ${date}, ${kpiPassedVideos.length} KPI-passing videos).`);
    return true;
  } catch (err) {
    logger.error(`[Database] saveScrapedData failed: ${err.message}`);
    return false;
  }
}

async function getScrapeStats(date) {
  if (!(await ensureConnected())) return null;
  try {
    const doc = await _db.collection('scraped_videos').findOne({ date });
    if (!doc) return null;
    return { totalVideos: doc.totalVideos, tiktokCount: doc.tiktokCount, instagramCount: doc.instagramCount };
  } catch (err) {
    logger.error(`[Database] getScrapeStats failed: ${err.message}`);
    return null;
  }
}

async function getKpiVideos(date) {
  if (!(await ensureConnected())) return null;
  try {
    const doc = await _db.collection('scraped_videos').findOne({ date });
    if (!doc || !doc.kpiPassedVideos) return null;
    return doc.kpiPassedVideos;
  } catch (err) {
    logger.error(`[Database] getKpiVideos failed: ${err.message}`);
    return null;
  }
}

// ─── Pipeline Runs ────────────────────────────────────────────────────────────
async function savePipelineRun(date, summary) {
  if (!(await ensureConnected())) return false;
  try {
    await _db.collection('pipeline_runs').replaceOne(
      { date },
      { date, runAt: new Date().toISOString(), ...summary },
      { upsert: true }
    );
    logger.info(`[Database] Pipeline run saved (date: ${date}).`);
    return true;
  } catch (err) {
    logger.error(`[Database] savePipelineRun failed: ${err.message}`);
    return false;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  connect,
  isConnected,
  // Recommendations
  saveRecommendations,
  getRecommendations,
  // Approval history
  saveApprovalDecision,
  getApprovalHistory,
  // Performance history
  savePerformancePosts,
  getPerformanceHistory,
  // Scrape data
  saveScrapedData,
  getScrapeStats,
  getKpiVideos,
  // Pipeline runs
  savePipelineRun,
};
