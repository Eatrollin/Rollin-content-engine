require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const os         = require('os');
const fse        = require('fs-extra');
const { exec }   = require('child_process');
const logger     = require('../logger');

const approvalManager = require('../approvalManager');
const higgsfield      = require('../higgsfield');
const kpiScorer       = require('../kpiScorer');
const db              = require('../database');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const OUTPUTS_BASE = process.env.OUTPUTS_PATH || path.join(os.homedir(), 'Desktop', 'rollin-outputs');
const RAW_DATA_DIR = path.join(__dirname, '..', '..', 'raw-data');
const PERF_HISTORY = path.join(__dirname, '..', '..', 'data', 'performance-history.json');

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function todayString() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Detroit' }));
  return d.toISOString().slice(0, 10);
}

function dateString(daysAgo = 0) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Detroit' }));
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// Load all recommendations for a given date — MongoDB primary, files fallback
async function loadRecs(date) {
  const mongoRecs = await db.getRecommendations(date).catch(() => null);
  if (mongoRecs && mongoRecs.length > 0) {
    return mongoRecs.sort((a, b) => (a.rank || 99) - (b.rank || 99));
  }
  // File fallback
  const recs = [];
  for (const tier of ['high', 'medium', 'low']) {
    const dir = path.join(OUTPUTS_BASE, date, tier);
    if (!(await fse.pathExists(dir))) continue;
    const files = await fse.readdir(dir);
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const data = await fse.readJson(path.join(dir, f));
        recs.push({ ...data, tier });
      } catch { /* skip */ }
    }
  }
  return recs.sort((a, b) => (a.rank || 99) - (b.rank || 99));
}

// Load KPI-passing videos for a date — MongoDB primary, files fallback
async function loadKpiVideos(date) {
  const mongoVideos = await db.getKpiVideos(date).catch(() => null);
  if (mongoVideos !== null) return mongoVideos;
  // File fallback
  const p = path.join(RAW_DATA_DIR, `${date}.json`);
  if (!(await fse.pathExists(p))) return [];
  try {
    const d = await fse.readJson(p);
    if (!d.videos || !d.videos.length) return [];
    const scored = kpiScorer.score(d.videos);
    return scored
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
  } catch { return []; }
}

// Load raw scrape summary for a date — MongoDB primary, files fallback
async function loadScrapeStats(date) {
  const mongoStats = await db.getScrapeStats(date).catch(() => null);
  if (mongoStats) return mongoStats;
  // File fallback
  const p = path.join(RAW_DATA_DIR, `${date}.json`);
  if (!(await fse.pathExists(p))) return null;
  try {
    const d = await fse.readJson(p);
    return { totalVideos: d.totalVideos, tiktokCount: d.tiktokCount, instagramCount: d.instagramCount };
  } catch { return null; }
}

// Load last 7 days of @eatrollin performance for the line chart — MongoDB primary, files fallback
async function loadSevenDayPerf() {
  try {
    const mongoHistory = await db.getPerformanceHistory().catch(() => null);
    const history = mongoHistory || await fse.readJson(PERF_HISTORY).catch(() => ({ posts: [] }));
    const result  = [];
    for (let i = 6; i >= 0; i--) {
      const date  = dateString(i);
      const posts = (history.posts || []).filter(p => p.postedAt?.startsWith(date));
      const avgKpi = posts.length
        ? posts.reduce((s, p) => s + (p.latestMetrics?.kpiScore || 0), 0) / posts.length
        : null;
      result.push({ date, postCount: posts.length, avgKpi });
    }
    return result;
  } catch { return []; }
}

// ─── API: full dashboard state ────────────────────────────────────────────────
app.get('/api/state', async (req, res) => {
  try {
    const today    = req.query.date || todayString();
    const yesterday = dateString(1);

    const [recs, scrapeStats, scrapeYesterday, approvalHistory, mongoPerf, sevenDay, kpiVideos] = await Promise.all([
      loadRecs(today),
      loadScrapeStats(today),
      loadScrapeStats(yesterday),
      approvalManager.getApprovalHistory(),
      db.getPerformanceHistory().catch(() => null),
      loadSevenDayPerf(),
      loadKpiVideos(today),
    ]);
    // Performance history: MongoDB primary, file fallback
    const perfHistory = mongoPerf || await fse.readJson(PERF_HISTORY).catch(() => ({ posts: [] }));

    const todayApprovals = approvalHistory.decisions.filter(d => d.date === today && d.decision === 'approved').length;
    const todayRejections = approvalHistory.decisions.filter(d => d.date === today && d.decision === 'rejected').length;

    // KPI score distribution buckets
    const allScores = recs.map(r => r.kpi?.compositeScore || 0);
    const buckets = { '0.00-0.05': 0, '0.05-0.10': 0, '0.10-0.20': 0, '0.20+': 0 };
    allScores.forEach(s => {
      if      (s < 0.05) buckets['0.00-0.05']++;
      else if (s < 0.10) buckets['0.05-0.10']++;
      else if (s < 0.20) buckets['0.10-0.20']++;
      else               buckets['0.20+']++;
    });

    // Top keyword from today's recs
    const allHashtags = recs.flatMap(r => r.contentBrief?.hashtagSet || []);
    const tagCounts   = {};
    allHashtags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
    const topKeyword  = Object.entries(tagCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || '—';

    // Tier cluster for doughnut
    const tierCounts = { high: recs.filter(r=>r.tier==='high').length, medium: recs.filter(r=>r.tier==='medium').length, low: recs.filter(r=>r.tier==='low').length };

    // @eatrollin day-over-day
    const ownPosts = perfHistory.posts || [];
    const ydPosts  = ownPosts.filter(p => { if(!p.postedAt) return false; const h=(Date.now()-new Date(p.postedAt).getTime())/3600000; return h>=24&&h<=48; });
    const d2Posts  = ownPosts.filter(p => { if(!p.postedAt) return false; const h=(Date.now()-new Date(p.postedAt).getTime())/3600000; return h>=48&&h<=72; });
    const ydAvg    = ydPosts.length ? ydPosts.reduce((s,p)=>s+(p.latestMetrics?.kpiScore||0),0)/ydPosts.length : null;
    const d2Avg    = d2Posts.length ? d2Posts.reduce((s,p)=>s+(p.latestMetrics?.kpiScore||0),0)/d2Posts.length : null;
    const changePct = (ydAvg && d2Avg && d2Avg > 0) ? ((ydAvg-d2Avg)/d2Avg*100).toFixed(1) : null;

    res.json({
      date: today,
      metrics: {
        totalScraped:    scrapeStats?.totalVideos    ?? 0,
        tiktokCount:     scrapeStats?.tiktokCount    ?? 0,
        instagramCount:  scrapeStats?.instagramCount ?? 0,
        yesterdayTotal:  scrapeYesterday?.totalVideos ?? 0,
        passedKpi:       kpiVideos.length,
        topKeyword,
        dayOverDayPct:   changePct,
        dayOverDayTrend: changePct === null ? 'no-data' : Number(changePct) > 0 ? 'up' : Number(changePct) < 0 ? 'down' : 'flat',
        todayApprovals,
        todayRejections,
        approvalCap: approvalManager.MAX_APPROVALS_PER_DAY,
      },
      charts: {
        kpiDistribution: buckets,
        tierClusters:    tierCounts,
        sevenDayPerf:    sevenDay,
      },
      kpiVideos,
      recommendations: recs,
      higgsfieldJobs: recs
        .filter(r => r.higgsfield?.jobId)
        .map(r => ({ recId: r.id, title: r.title, tier: r.tier, ...r.higgsfield })),
      history: ownPosts
        .filter(p => p.checkpoints?.['72h']?.isFinal)
        .sort((a,b) => new Date(b.postedAt)-new Date(a.postedAt))
        .slice(0, 20)
        .map(p => ({
          id: p.id, platform: p.platform, url: p.url,
          caption: p.caption?.slice(0,150),
          postedAt: p.postedAt,
          kpi72h: p.checkpoints['72h'].kpiScore,
          views72h: p.checkpoints['72h'].viewCount,
          wasApproved: p.wasApproved, wasRecommended: p.wasRecommended,
        })),
    });
  } catch (err) {
    logger.error(`[Dashboard] /api/state error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: approve ─────────────────────────────────────────────────────────────
app.post('/api/approve', async (req, res) => {
  const { recId, date, tier, note } = req.body;
  if (!recId || !date) return res.status(400).json({ error: 'recId and date required' });
  try {
    const result = await approvalManager.approve(recId, date, tier, note || '');
    if (result.success) io.emit('approval:update', { recId, decision: 'approved', ...result });
    res.json(result);
  } catch (err) {
    logger.error(`[Dashboard] /api/approve error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: reject ──────────────────────────────────────────────────────────────
app.post('/api/reject', async (req, res) => {
  const { recId, date, tier, note } = req.body;
  if (!recId || !date) return res.status(400).json({ error: 'recId and date required' });
  try {
    const result = await approvalManager.reject(recId, date, tier, note || '');
    if (result.success) io.emit('approval:update', { recId, decision: 'rejected', ...result });
    res.json(result);
  } catch (err) {
    logger.error(`[Dashboard] /api/reject error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Higgsfield job status ───────────────────────────────────────────────
app.get('/api/higgsfield/:jobId', async (req, res) => {
  try {
    const status = await higgsfield.checkJobStatus(req.params.jobId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info(`[Dashboard] Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    logger.info(`[Dashboard] Client disconnected: ${socket.id}`);
  });
});

// ─── Exported emit (used by pipeline.js) ─────────────────────────────────────
function emit(event, data) {
  io.emit(event, data);
}

// ─── Start ────────────────────────────────────────────────────────────────────
function start() {
  db.connect();   // non-blocking — DB reads fall back to files if this fails
  server.listen(PORT, () => {
    logger.info(`[Dashboard] Running at http://localhost:${PORT}`);
    // Auto-open browser (Windows: start, macOS: open, Linux: xdg-open)
    const cmd = process.platform === 'win32' ? `start http://localhost:${PORT}`
              : process.platform === 'darwin' ? `open http://localhost:${PORT}`
              : `xdg-open http://localhost:${PORT}`;
    exec(cmd, (err) => {
      if (err) logger.warn(`[Dashboard] Could not auto-open browser: ${err.message}`);
    });
  });
}

module.exports = { start, emit };
