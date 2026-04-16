require('dotenv').config();

const logger = require('./logger');
const path = require('path');
const fse  = require('fs-extra');
const { DATA_DIR } = require('./config');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDetroitDateString() {
  const now = new Date();
  const detroit = new Date(now.toLocaleString('en-US', { timeZone: 'America/Detroit' }));
  const yyyy = detroit.getFullYear();
  const mm = String(detroit.getMonth() + 1).padStart(2, '0');
  const dd = String(detroit.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Pipeline state shared between steps ─────────────────────────────────────
// Each step reads from and writes to this object so modules stay decoupled.
// As steps are built they will populate and consume these fields.
let state = {};

// ─── Step runner — logs each step, catches errors without stopping pipeline ──
async function runStep(name, fn) {
  logger.info(`──────────────────────────────────────────`);
  logger.info(`STEP: ${name}`);
  const t0 = Date.now();
  try {
    await fn();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.info(`✓ ${name} — done in ${elapsed}s`);
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.error(`✗ ${name} — FAILED after ${elapsed}s: ${err.message}`);
    logger.error(err.stack);
    // Log and continue — no single step failure stops the pipeline
  }
}

// ─── Test mode: load most recent raw-data file instead of scraping ────────────
async function loadMostRecentRawData() {
  const rawDataDir = path.join(DATA_DIR, 'raw-data');
  await fse.ensureDir(rawDataDir);
  const files = (await fse.readdir(rawDataDir))
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) {
    throw new Error(`No raw-data files found in ${rawDataDir}. Run without --test first.`);
  }
  const file = files[0];
  logger.info(`[TEST MODE] Loading raw data from: ${file}`);
  const data = await fse.readJson(path.join(rawDataDir, file));
  logger.info(`[TEST MODE] Loaded ${data.videos?.length ?? 0} videos (date: ${data.date})`);
  return { videos: data.videos || [], trendingSounds: data.trendingSounds || [] };
}

// ─── Main pipeline entry point ───────────────────────────────────────────────
async function run({ testMode = false } = {}) {
  const pipelineStart = Date.now();
  const dateString = getDetroitDateString();

  state = {
    date: dateString,
    rawDataPath: path.join(DATA_DIR, 'raw-data', `${dateString}.json`),
    outputsBase: path.join(DATA_DIR, 'outputs', dateString),
    scrapedVideos: [],
    scoredVideos: [],
    transcriptions: {},
    trendAnalysis: null,
    recommendations: [],
    higgsfieldJobs: [],
    ownPostPerformance: [],
    perplexityFindings: null,
    trendingSounds: [],
    emailSent: false,
  };

  // Ensure output directories exist
  fse.ensureDirSync(path.join(state.outputsBase, 'high'));
  fse.ensureDirSync(path.join(state.outputsBase, 'medium'));
  fse.ensureDirSync(path.join(state.outputsBase, 'low'));

  logger.info('');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(' ROLLIN CONTENT ENGINE — PIPELINE STARTING ');
  logger.info(` Date: ${dateString}  (America/Detroit)     `);
  if (testMode) logger.info(' ⚡ TEST MODE — skipping Apify scrape         ');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── Step 3: Scrape TikTok + Instagram (or load cached data in test mode) ───
  await runStep('Step 3 — Data Collection (Apify)', async () => {
    let result;
    if (testMode) {
      result = await loadMostRecentRawData();
      logger.info(`[TEST MODE] Loaded ${result.videos.length} videos from raw-data cache.`);
    } else {
      const scraper = require('./scraper');
      result = await scraper.run(state.date);
      logger.info(`Scraped ${result.videos.length} videos total.`);
    }
    state.scrapedVideos  = result.videos;
    state.trendingSounds = result.trendingSounds || [];
    const trendingCount  = state.trendingSounds.filter((s) => s.trending).length;
    if (trendingCount > 0) logger.info(`${trendingCount} trending sound(s) detected.`);
  });

  // ── Step 2.5: Perplexity Research (parallel API searches) ────────────────
  await runStep('Step 2.5 — Perplexity Research', async () => {
    const perplexityResearch = require('./perplexityResearch');
    state.perplexityFindings = await perplexityResearch.run(state.scrapedVideos, state.date);
    if (state.perplexityFindings) {
      logger.info(`Perplexity: ${state.perplexityFindings.findings.length} searches completed for ${state.date}.`);
    }
  });

  // ── Step 4: KPI Scoring ────────────────────────────────────────────────────
  await runStep('Step 4 — KPI Scoring', async () => {
    const kpiScorer = require('./kpiScorer');
    state.scoredVideos = kpiScorer.score(state.scrapedVideos);
    const passed = state.scoredVideos.filter((v) => v.passedKpiThreshold).length;
    logger.info(`KPI scored ${state.scoredVideos.length} videos. ${passed} passed threshold.`);
  });

  // ── Step 9 (pre-run): Learning loop — check @eatrollin performance ─────────
  await runStep('Step 9 — Learning Loop (@eatrollin performance)', async () => {
    const learningLoop = require('./learningLoop');
    state.ownPostPerformance = await learningLoop.run();
    logger.info(`Learning loop evaluated ${state.ownPostPerformance.length} @eatrollin posts.`);
  });

  // ── Step 5: Transcription ──────────────────────────────────────────────────
  await runStep('Step 5 — Transcription (Whisper)', async () => {
    const transcriber = require('./transcriber');
    state.transcriptions = await transcriber.run(state.scoredVideos);
    const count = Object.keys(state.transcriptions).length;
    logger.info(`Transcribed ${count} videos.`);
  });

  // ── Step 6: AI Trend Analysis ──────────────────────────────────────────────
  await runStep('Step 6 — AI Trend Analysis (Claude)', async () => {
    const analyzer = require('./analyzer');
    // Pass full learning loop result (includes learningContext + dayOverDay)
    state.trendAnalysis = await analyzer.run(
      state.scoredVideos,
      state.transcriptions,
      state.ownPostPerformance,    // { posts, learningContext, dayOverDay }
      state.perplexityFindings,    // null if key missing or all searches failed
      state.trendingSounds         // top 5 audio tracks from full dataset
    );
    const trendCount = state.trendAnalysis?.confirmedTrends?.length ?? 0;
    logger.info(`Analysis complete. ${trendCount} confirmed trends identified.`);
  });

  // ── Step 7: Content Recommendations ───────────────────────────────────────
  await runStep('Step 7 — Content Recommendations', async () => {
    const recommender = require('./recommender');
    state.recommendations = await recommender.run(
      state.trendAnalysis,
      state.scoredVideos,
      state.date,
      state.outputsBase
    );
    logger.info(`Generated ${state.recommendations.length} recommendations.`);
  });

  // ── Step 8: Higgsfield Video Generation ───────────────────────────────────
  await runStep('Step 8 — Higgsfield Video Generation', async () => {
    const higgsfield = require('./higgsfield');
    state.higgsfieldJobs = await higgsfield.run(state.recommendations, state.date);
    logger.info(`Submitted ${state.higgsfieldJobs.length} Higgsfield job(s).`);
  });

  // ── Step 12: Daily Email ───────────────────────────────────────────────────
  await runStep('Step 12 — Daily Email', async () => {
    const emailer = require('./emailer');
    await emailer.send(state);
    state.emailSent = true;
    logger.info(`Email sent to chasezaidan@eatrollin.food`);
  });

  // ── Emit fresh data to the dashboard over Socket.io ───────────────────────
  try {
    const dashboardServer = require('./dashboard/server');
    dashboardServer.emit('pipeline:complete', state);
  } catch (_) {
    // Dashboard may not be running — not a pipeline failure
  }

  const totalSeconds = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  logger.info('');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(` PIPELINE COMPLETE — ${totalSeconds}s total  `);
  logger.info(` Recommendations: ${state.recommendations.length}`);
  logger.info(` Email sent: ${state.emailSent}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('');
}

module.exports = { run };
