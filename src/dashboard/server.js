require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fse        = require('fs-extra');
const { exec }   = require('child_process');
const logger     = require('../logger');
const { DATA_DIR } = require('../config');

const approvalManager = require('../approvalManager');
const higgsfield      = require('../higgsfield');
const kpiScorer       = require('../kpiScorer');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3000', 10);
const OUTPUTS_BASE = path.join(DATA_DIR, 'outputs');
const RAW_DATA_DIR = path.join(DATA_DIR, 'raw-data');
const PERF_HISTORY = path.join(DATA_DIR, 'performance-history.json');

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function todayString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());
}

function dateString(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(d);
}

// Load all recommendations for a given date from the file system
async function loadRecs(date) {
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

// Load KPI-passing videos for a date from raw-data files
async function loadKpiVideos(date) {
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

// Load raw scrape summary for a date from raw-data files
async function loadScrapeStats(date) {
  const p = path.join(RAW_DATA_DIR, `${date}.json`);
  if (!(await fse.pathExists(p))) return null;
  try {
    const d = await fse.readJson(p);
    return { totalVideos: d.totalVideos, tiktokCount: d.tiktokCount, instagramCount: d.instagramCount };
  } catch { return null; }
}

// Load last 7 days of @eatrollin performance for the line chart
async function loadSevenDayPerf() {
  try {
    const history = await fse.readJson(PERF_HISTORY).catch(() => ({ posts: [] }));
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
    const today     = req.query.date || todayString();
    const yesterday = dateString(1);

    const [recs, scrapeStats, scrapeYesterday, approvalHistory, sevenDay, kpiVideos] = await Promise.all([
      loadRecs(today),
      loadScrapeStats(today),
      loadScrapeStats(yesterday),
      approvalManager.getApprovalHistory(),
      loadSevenDayPerf(),
      loadKpiVideos(today),
    ]);

    const perfHistory = await fse.readJson(PERF_HISTORY).catch(() => ({ posts: [] }));

    const todayApprovals  = approvalHistory.decisions.filter(d => d.date === today && d.decision === 'approved').length;
    const todayRejections = approvalHistory.decisions.filter(d => d.date === today && d.decision === 'rejected').length;

    // Top keywords from today's recs
    const allHashtags = recs.flatMap(r => r.contentBrief?.hashtagSet || []);
    const tagCounts   = {};
    allHashtags.forEach(t => {
      const clean = t.replace(/^#+/, '').toLowerCase().trim();
      if (clean) tagCounts[clean] = (tagCounts[clean] || 0) + 1;
    });
    const topKeywords3 = Object.entries(tagCounts)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 3)
      .map(([tag]) => '#' + tag);

    // @eatrollin day-over-day
    const ownPosts = perfHistory.posts || [];
    const ydPosts  = ownPosts.filter(p => { if (!p.postedAt) return false; const h = (Date.now() - new Date(p.postedAt).getTime()) / 3600000; return h >= 24 && h <= 48; });
    const d2Posts  = ownPosts.filter(p => { if (!p.postedAt) return false; const h = (Date.now() - new Date(p.postedAt).getTime()) / 3600000; return h >= 48 && h <= 72; });
    const ydAvg    = ydPosts.length ? ydPosts.reduce((s,p) => s + (p.latestMetrics?.kpiScore || 0), 0) / ydPosts.length : null;
    const d2Avg    = d2Posts.length ? d2Posts.reduce((s,p) => s + (p.latestMetrics?.kpiScore || 0), 0) / d2Posts.length : null;
    const changePct = (ydAvg && d2Avg && d2Avg > 0) ? ((ydAvg - d2Avg) / d2Avg * 100).toFixed(1) : null;

    res.json({
      date: today,
      metrics: {
        totalScraped:    scrapeStats?.totalVideos    ?? 0,
        tiktokCount:     scrapeStats?.tiktokCount    ?? 0,
        instagramCount:  scrapeStats?.instagramCount ?? 0,
        yesterdayTotal:  scrapeYesterday?.totalVideos ?? 0,
        passedKpi:       kpiVideos.length,
        topKeywords3:    topKeywords3.length > 0 ? topKeywords3 : ['—'],
        dayOverDayPct:   changePct,
        dayOverDayTrend: changePct === null ? 'no-data' : Number(changePct) > 0 ? 'up' : Number(changePct) < 0 ? 'down' : 'flat',
        todayApprovals,
        todayRejections,
        approvalCap: approvalManager.MAX_APPROVALS_PER_DAY,
      },
      kpiVideos,
      recommendations: recs,
      higgsfieldJobs: recs
        .filter(r => r.higgsfield?.jobId)
        .map(r => ({ recId: r.id, title: r.title, tier: r.tier, ...r.higgsfield })),
      history: ownPosts
        .filter(p => p.checkpoints?.['72h']?.isFinal)
        .sort((a,b) => new Date(b.postedAt) - new Date(a.postedAt))
        .slice(0, 20)
        .map(p => ({
          id: p.id, platform: p.platform, url: p.url,
          caption: p.caption?.slice(0, 150),
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

// ─── API: single recommendation ──────────────────────────────────────────────
app.get('/api/recommendation/:recId', async (req, res) => {
  const { recId } = req.params;
  const date      = req.query.date || todayString();
  const dateDir   = path.join(OUTPUTS_BASE, date);
  try {
    for (const tier of ['high', 'medium', 'low']) {
      const tierDir = path.join(dateDir, tier);
      if (!(await fse.pathExists(tierDir))) continue;
      const files = (await fse.readdir(tierDir)).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = await fse.readJson(path.join(tierDir, f));
          if (data.id === recId) return res.json(data);
        } catch { /* skip corrupt file */ }
      }
    }
    res.status(404).json({ error: 'Recommendation not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: dates ───────────────────────────────────────────────────────────────
app.get('/api/dates', async (req, res) => {
  try {
    const exists = await fse.pathExists(OUTPUTS_BASE);
    if (!exists) return res.json({ dates: [] });
    const entries = await fse.readdir(OUTPUTS_BASE);
    const dates = entries
      .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e))
      .sort()
      .reverse();
    res.json({ dates });
  } catch (err) {
    res.json({ dates: [] });
  }
});

// ─── API: debug ───────────────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const fse = require('fs-extra');
  const path = require('path');
  const { DATA_DIR } = require('../config');
  try {
    const outputsBase = path.join(DATA_DIR, 'outputs');
    const exists = await fse.pathExists(outputsBase);
    const dirs = exists ? await fse.readdir(outputsBase) : [];
    res.json({ DATA_DIR, outputsBase, exists, dirs });
  } catch (err) {
    res.json({ error: err.message, DATA_DIR });
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

// ─── API: series ─────────────────────────────────────────────────────────────
const seriesManager = require('../seriesManager');

app.get('/api/series', async (req, res) => {
  try {
    const data = await seriesManager.loadSeries();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/series/create', async (req, res) => {
  const { recId, date, tier } = req.body;
  if (!recId || !date) return res.status(400).json({ error: 'recId and date required' });
  try {
    const dateDir = path.join(OUTPUTS_BASE, date);
    let rec = null;
    for (const t of [tier, 'high', 'medium', 'low'].filter(Boolean)) {
      const tierDir = path.join(dateDir, t);
      if (!(await fse.pathExists(tierDir))) continue;
      const files = (await fse.readdir(tierDir)).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = await fse.readJson(path.join(tierDir, f));
          if (data.id === recId) { rec = data; break; }
        } catch { /* skip */ }
      }
      if (rec) break;
    }
    if (!rec) return res.status(404).json({ error: 'Recommendation not found' });
    const series = await seriesManager.createSeries(rec, `New Series — ${(rec.title || '').slice(0, 30)}`);
    res.json({ success: true, series });
  } catch (err) {
    logger.error(`[Dashboard] /api/series/create error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/series/:seriesId/approve/:episodeId', async (req, res) => {
  const { seriesId, episodeId } = req.params;
  const { note } = req.body || {};
  try {
    const result = await seriesManager.approveEpisode(seriesId, episodeId, note || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/series/:seriesId/reject/:episodeId', async (req, res) => {
  const { seriesId, episodeId } = req.params;
  const { note } = req.body || {};
  try {
    const result = await seriesManager.rejectEpisode(seriesId, episodeId, note || '');
    res.json(result);
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
  server.listen(PORT, () => {
    logger.info(`[Dashboard] Running at http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
      try {
        const cmd = process.platform === 'win32' ? `start http://localhost:${PORT}`
                  : process.platform === 'darwin' ? `open http://localhost:${PORT}`
                  : `xdg-open http://localhost:${PORT}`;
        exec(cmd);
      } catch (_) { /* silent — browser auto-open is best-effort on dev only */ }
    }
  });
}

module.exports = { start, emit };
