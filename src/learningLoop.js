require('dotenv').config();

const { ApifyClient } = require('apify-client');
const fse    = require('fs-extra');
const path   = require('path');
const logger = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const EATROLLIN_HANDLE     = 'eatrollin';
const TIKTOK_ACTOR         = 'clockworks/tiktok-scraper';
const INSTAGRAM_ACTOR      = 'apify/instagram-scraper';

const PERF_HISTORY_PATH    = path.join(__dirname, '..', 'data', 'performance-history.json');
const APPROVAL_HISTORY_PATH = path.join(__dirname, '..', 'data', 'approval-history.json');

// Checkpoint windows in hours
const CHECKPOINT_24H_MIN   = 22;    // record 24h metrics if post is >= 22h old
const CHECKPOINT_24H_MAX   = 36;    // don't re-record if already done
const CHECKPOINT_72H_MIN   = 70;    // record 72h metrics if post is >= 70h old
const CHECKPOINT_72H_MAX   = 120;   // look back up to 5 days

// Max posts to scrape from @eatrollin per platform
const MAX_OWN_POSTS        = 30;

// ─── Apify client (lazy) ─────────────────────────────────────────────────────
let _client = null;
function apify() {
  if (!_client) _client = new ApifyClient({ token: process.env.APIFY_API_KEY });
  return _client;
}

// ─── Hours since a timestamp ─────────────────────────────────────────────────
function hoursSince(isoTimestamp) {
  if (!isoTimestamp) return null;
  return (Date.now() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60);
}

// ─── KPI score (same formula as kpiScorer.js — base only) ────────────────────
function calcKpi(metrics) {
  const views = metrics.viewCount || 0;
  if (views === 0) return 0;
  const shareRate   = (metrics.shareCount   || 0) / views;
  const saveRate    = (metrics.saveCount    || 0) / views;
  const commentRate = (metrics.commentCount || 0) / views;
  return (shareRate * 0.50) + (saveRate * 0.30) + (commentRate * 0.20);
}

// ─── Scrape @eatrollin TikTok ─────────────────────────────────────────────────
async function scrapeEatrollinTikTok() {
  logger.info('[LearningLoop] Scraping @eatrollin on TikTok...');
  try {
    const run = await apify().actor(TIKTOK_ACTOR).call(
      {
        type:            'user',
        profiles:        [EATROLLIN_HANDLE],
        resultsPerPage:  MAX_OWN_POSTS,
        maxItems:        MAX_OWN_POSTS,
        proxyConfiguration: { useApifyProxy: true },
      },
      { waitSecs: 180 }
    );
    const { items } = await apify().dataset(run.defaultDatasetId).listItems({ limit: MAX_OWN_POSTS });
    logger.info(`[LearningLoop] @eatrollin TikTok: ${items.length} posts found`);
    return items.map((raw) => ({
      id:             raw.id || raw.webVideoUrl,
      platform:       'tiktok',
      url:            raw.webVideoUrl || '',
      caption:        raw.text || '',
      hashtags:       (raw.hashtags || []).map((h) => (typeof h === 'string' ? h : h?.name || '')),
      postedAt:       raw.createTime ? new Date(raw.createTime * 1000).toISOString() : null,
      viewCount:      raw.playCount    || 0,
      likeCount:      raw.diggCount    || 0,
      commentCount:   raw.commentCount || 0,
      shareCount:     raw.shareCount   || 0,
      saveCount:      raw.collectCount || 0,
      audioName:      raw.musicMeta?.musicName || '',
    }));
  } catch (err) {
    logger.error(`[LearningLoop] TikTok scrape failed: ${err.message}`);
    return [];
  }
}

// ─── Scrape @eatrollin Instagram ──────────────────────────────────────────────
async function scrapeEatrollinInstagram() {
  logger.info('[LearningLoop] Scraping @eatrollin on Instagram...');
  try {
    const run = await apify().actor(INSTAGRAM_ACTOR).call(
      {
        directUrls:   [`https://www.instagram.com/${EATROLLIN_HANDLE}/`],
        resultsType:  'posts',
        resultsLimit: MAX_OWN_POSTS,
        addParentData: true,
        proxy: { useApifyProxy: true },
      },
      { waitSecs: 180 }
    );
    const { items } = await apify().dataset(run.defaultDatasetId).listItems({ limit: MAX_OWN_POSTS });
    logger.info(`[LearningLoop] @eatrollin Instagram: ${items.length} posts found`);
    return items.map((raw) => ({
      id:           raw.id || raw.shortCode || raw.url,
      platform:     'instagram',
      url:          raw.url || '',
      caption:      raw.caption || '',
      hashtags:     (raw.hashtags || []).map((h) => (typeof h === 'string' ? h : '')),
      postedAt:     raw.timestamp ? new Date(raw.timestamp).toISOString() : null,
      viewCount:    raw.videoViewCount || raw.videoPlayCount || raw.likesCount || 0,
      likeCount:    raw.likesCount     || 0,
      commentCount: raw.commentsCount  || 0,
      shareCount:   0,  // not exposed
      saveCount:    0,  // not exposed
      audioName:    raw.musicInfo?.songName || '',
    }));
  } catch (err) {
    logger.error(`[LearningLoop] Instagram scrape failed: ${err.message}`);
    return [];
  }
}

// ─── Load persisted data ──────────────────────────────────────────────────────
async function loadHistory() {
  try {
    return await fse.readJson(PERF_HISTORY_PATH);
  } catch {
    return { posts: [], updatedAt: null };
  }
}

async function loadApprovals() {
  try {
    return await fse.readJson(APPROVAL_HISTORY_PATH);
  } catch {
    return { decisions: [] };
  }
}

// ─── Cross-reference a post against approval history ─────────────────────────
function crossReference(post, approvals) {
  const decisions = approvals.decisions || [];

  // Match by URL or caption similarity
  const matched = decisions.find(
    (d) => d.postUrl === post.url ||
           (d.caption && post.caption && d.caption.slice(0, 80) === post.caption.slice(0, 80))
  );

  if (!matched) {
    return { wasRecommended: false, wasApproved: false, wasRejected: false };
  }

  return {
    wasRecommended:   true,
    recommendationId: matched.recommendationId || null,
    wasApproved:      matched.decision === 'approved',
    wasRejected:      matched.decision === 'rejected',
    approvedAt:       matched.approvedAt || null,
    rejectedAt:       matched.rejectedAt || null,
    approvalNote:     matched.note || '',
  };
}

// ─── Update or create a post record in history ────────────────────────────────
function updatePostRecord(existing, fresh, approvals) {
  const hours = hoursSince(fresh.postedAt);
  const xref  = crossReference(fresh, approvals);

  // Metrics snapshot for the current reading
  const currentMetrics = {
    recordedAt:   new Date().toISOString(),
    viewCount:    fresh.viewCount,
    likeCount:    fresh.likeCount,
    commentCount: fresh.commentCount,
    shareCount:   fresh.shareCount,
    saveCount:    fresh.saveCount,
    kpiScore:     calcKpi(fresh),
  };

  // Build or update the post record
  const record = existing || {
    id:          fresh.id,
    platform:    fresh.platform,
    url:         fresh.url,
    caption:     fresh.caption,
    hashtags:    fresh.hashtags,
    audioName:   fresh.audioName,
    postedAt:    fresh.postedAt,
    firstSeenAt: new Date().toISOString(),
    checkpoints: {},
    latestMetrics: null,
    ...xref,
    actualPerformance: 'pending',
  };

  // Always update latest metrics and cross-reference
  record.latestMetrics = currentMetrics;
  Object.assign(record, xref);

  // Record 24h checkpoint
  if (hours >= CHECKPOINT_24H_MIN && hours <= CHECKPOINT_24H_MAX && !record.checkpoints['24h']) {
    record.checkpoints['24h'] = currentMetrics;
    logger.info(
      `[LearningLoop]   24h checkpoint recorded for @${EATROLLIN_HANDLE} ` +
      `${fresh.platform} post (${hours.toFixed(1)}h old) — KPI: ${currentMetrics.kpiScore.toFixed(6)}`
    );
  }

  // Record 72h checkpoint (final evaluation)
  if (hours >= CHECKPOINT_72H_MIN && hours <= CHECKPOINT_72H_MAX && !record.checkpoints['72h']) {
    record.checkpoints['72h'] = { ...currentMetrics, isFinal: true };
    record.actualPerformance  = 'evaluated';
    logger.info(
      `[LearningLoop]   72h FINAL checkpoint for @${EATROLLIN_HANDLE} ` +
      `${fresh.platform} post — Final KPI: ${currentMetrics.kpiScore.toFixed(6)}`
    );
  }

  return record;
}

// ─── Build learning context for Claude ───────────────────────────────────────
// Produces a plain-English + structured summary of what has and hasn't worked
// on @eatrollin. Passed directly into the analyzer's Claude prompt.
function buildLearningContext(history, approvals) {
  const posts = history.posts || [];
  const decisions = approvals.decisions || [];

  // Posts with final 72h evaluations
  const evaluated = posts.filter((p) => p.checkpoints?.['72h']?.isFinal);
  const approved  = decisions.filter((d) => d.decision === 'approved');
  const rejected  = decisions.filter((d) => d.decision === 'rejected');

  // Top performing approved posts (by 72h KPI)
  const topPerformers = evaluated
    .filter((p) => p.wasApproved)
    .sort((a, b) => (b.checkpoints['72h'].kpiScore || 0) - (a.checkpoints['72h'].kpiScore || 0))
    .slice(0, 5);

  // Worst performing approved posts
  const lowPerformers = evaluated
    .filter((p) => p.wasApproved)
    .sort((a, b) => (a.checkpoints['72h'].kpiScore || 0) - (b.checkpoints['72h'].kpiScore || 0))
    .slice(0, 3);

  // Rejected content patterns
  const rejectedSamples = rejected.slice(-10).map((d) => ({
    note:   d.note || 'No reason given',
    caption: d.caption?.slice(0, 100) || '',
  }));

  // Average KPI for approved vs all posts
  const avgApprovedKpi = topPerformers.length > 0
    ? topPerformers.reduce((s, p) => s + (p.checkpoints['72h'].kpiScore || 0), 0) / topPerformers.length
    : null;

  return {
    summary: {
      totalPostsTracked:     posts.length,
      postsWithFinalEval:    evaluated.length,
      totalApproved:         approved.length,
      totalRejected:         rejected.length,
      avgApprovedKpi72h:     avgApprovedKpi ? Number(avgApprovedKpi.toFixed(6)) : null,
    },
    topPerformingApprovedPosts: topPerformers.map((p) => ({
      platform:     p.platform,
      caption:      p.caption?.slice(0, 200),
      hashtags:     p.hashtags,
      audio:        p.audioName,
      kpi72h:       p.checkpoints['72h'].kpiScore,
      views72h:     p.checkpoints['72h'].viewCount,
      postedAt:     p.postedAt,
    })),
    lowPerformingApprovedPosts: lowPerformers.map((p) => ({
      platform:     p.platform,
      caption:      p.caption?.slice(0, 150),
      kpi72h:       p.checkpoints['72h'].kpiScore,
      postedAt:     p.postedAt,
    })),
    rejectedContentPatterns: rejectedSamples,
    recentPosts: posts
      .filter((p) => p.postedAt)
      .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt))
      .slice(0, 10)
      .map((p) => ({
        platform:           p.platform,
        caption:            p.caption?.slice(0, 150),
        postedAt:           p.postedAt,
        latestKpi:          p.latestMetrics?.kpiScore || 0,
        latestViews:        p.latestMetrics?.viewCount || 0,
        checkpoint24hKpi:   p.checkpoints?.['24h']?.kpiScore || null,
        checkpoint72hKpi:   p.checkpoints?.['72h']?.kpiScore || null,
        wasApproved:        p.wasApproved,
        wasRejected:        p.wasRejected,
        actualPerformance:  p.actualPerformance,
      })),
    learningNote: evaluated.length === 0
      ? 'No @eatrollin posts have reached the 72h evaluation window yet. The system will start learning as posts accumulate.'
      : `${evaluated.length} posts have been fully evaluated. Use topPerformingApprovedPosts and lowPerformingApprovedPosts to calibrate recommendations toward what actually works on @eatrollin.`,
  };
}

// ─── Compare today vs yesterday for email/dashboard ─────────────────────────
function calcDayOverDay(history) {
  const posts = history.posts || [];
  const now = Date.now();

  const yesterdayPosts = posts.filter((p) => {
    if (!p.postedAt) return false;
    const h = hoursSince(p.postedAt);
    return h >= 24 && h <= 48;
  });

  const twoDaysAgoPosts = posts.filter((p) => {
    if (!p.postedAt) return false;
    const h = hoursSince(p.postedAt);
    return h >= 48 && h <= 72;
  });

  function avgKpi(arr) {
    if (!arr.length) return 0;
    const scores = arr.map((p) => p.checkpoints?.['24h']?.kpiScore || p.latestMetrics?.kpiScore || 0);
    return scores.reduce((s, v) => s + v, 0) / scores.length;
  }

  const yesterdayAvg  = avgKpi(yesterdayPosts);
  const twoDaysAgoAvg = avgKpi(twoDaysAgoPosts);
  const changePct     = twoDaysAgoAvg > 0
    ? ((yesterdayAvg - twoDaysAgoAvg) / twoDaysAgoAvg) * 100
    : null;

  return {
    yesterdayPostCount:  yesterdayPosts.length,
    twoDaysAgoPostCount: twoDaysAgoPosts.length,
    yesterdayAvgKpi:     Number(yesterdayAvg.toFixed(6)),
    twoDaysAgoAvgKpi:    Number(twoDaysAgoAvg.toFixed(6)),
    changePercent:       changePct !== null ? Number(changePct.toFixed(1)) : null,
    trend:               changePct === null   ? 'no-data'
                       : changePct > 5        ? 'up'
                       : changePct < -5       ? 'down'
                       : 'flat',
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  logger.info('[LearningLoop] ─────────────────────────────────────────────');
  logger.info('[LearningLoop] Evaluating @eatrollin post performance...');
  logger.info('[LearningLoop] Checkpoints: 24h (early signal) + 72h (final)');
  logger.info('[LearningLoop] ─────────────────────────────────────────────');

  // ── Load existing history and approvals ───────────────────────────────────
  const [history, approvals] = await Promise.all([loadHistory(), loadApprovals()]);
  logger.info(`[LearningLoop] History loaded: ${history.posts?.length ?? 0} tracked posts`);
  logger.info(`[LearningLoop] Approvals loaded: ${approvals.decisions?.length ?? 0} decisions`);

  // ── Scrape @eatrollin on both platforms ───────────────────────────────────
  const [tiktokPosts, instagramPosts] = await Promise.all([
    scrapeEatrollinTikTok().catch((err) => {
      logger.error(`[LearningLoop] TikTok scrape error: ${err.message}`);
      return [];
    }),
    scrapeEatrollinInstagram().catch((err) => {
      logger.error(`[LearningLoop] Instagram scrape error: ${err.message}`);
      return [];
    }),
  ]);

  const freshPosts = [...tiktokPosts, ...instagramPosts];
  logger.info(`[LearningLoop] Fresh posts scraped: ${freshPosts.length} total`);

  if (freshPosts.length === 0) {
    logger.warn('[LearningLoop] No @eatrollin posts found — using existing history only.');
    const learningContext = buildLearningContext(history, approvals);
    const dayOverDay      = calcDayOverDay(history);
    return { posts: history.posts || [], learningContext, dayOverDay };
  }

  // ── Update history with fresh data ────────────────────────────────────────
  const existingMap = {};
  for (const p of (history.posts || [])) {
    existingMap[p.id] = p;
  }

  let newCount      = 0;
  let updated24h    = 0;
  let updated72h    = 0;

  for (const fresh of freshPosts) {
    if (!fresh.id) continue;
    const existing = existingMap[fresh.id] || null;
    const before24 = existing?.checkpoints?.['24h'] ? 1 : 0;
    const before72 = existing?.checkpoints?.['72h'] ? 1 : 0;

    const updated = updatePostRecord(existing, fresh, approvals);
    existingMap[fresh.id] = updated;

    if (!existing) newCount++;
    if (!before24 && updated.checkpoints?.['24h']) updated24h++;
    if (!before72 && updated.checkpoints?.['72h']) updated72h++;
  }

  logger.info(`[LearningLoop] New posts discovered:      ${newCount}`);
  logger.info(`[LearningLoop] 24h checkpoints recorded:  ${updated24h}`);
  logger.info(`[LearningLoop] 72h checkpoints recorded:  ${updated72h}`);

  // ── Save updated history ──────────────────────────────────────────────────
  const updatedHistory = {
    updatedAt: new Date().toISOString(),
    posts:     Object.values(existingMap),
  };
  await fse.writeJson(PERF_HISTORY_PATH, updatedHistory, { spaces: 2 });
  logger.info(`[LearningLoop] Performance history saved → ${PERF_HISTORY_PATH}`);

  // ── Build learning context for analyzer ───────────────────────────────────
  const learningContext = buildLearningContext(updatedHistory, approvals);
  const dayOverDay      = calcDayOverDay(updatedHistory);

  logger.info('[LearningLoop] ─────────────────────────────────────────────');
  logger.info(`[LearningLoop] Posts with 72h evaluation: ${learningContext.summary.postsWithFinalEval}`);
  logger.info(`[LearningLoop] Top performers tracked:    ${learningContext.topPerformingApprovedPosts.length}`);
  logger.info(`[LearningLoop] Rejected patterns logged:  ${learningContext.rejectedContentPatterns.length}`);
  logger.info(`[LearningLoop] Day-over-day trend:        ${dayOverDay.trend} (${dayOverDay.changePercent ?? 'n/a'}%)`);
  logger.info('[LearningLoop] Learning context ready for Claude.');
  logger.info('[LearningLoop] ─────────────────────────────────────────────');

  return {
    posts:           Object.values(existingMap),
    learningContext,
    dayOverDay,
  };
}

module.exports = { run, calcKpi, buildLearningContext, calcDayOverDay };
