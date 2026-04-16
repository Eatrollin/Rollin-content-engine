require('dotenv').config();

const { ApifyClient } = require('apify-client');
const fse = require('fs-extra');
const path = require('path');
const logger = require('./logger');
const { DATA_DIR } = require('./config');

// ─── TikTok sources ───────────────────────────────────────────────────────────
// Add/remove hashtags here. TIKTOK_HASHTAG_MAX controls results per hashtag run.
const TRACKED_HASHTAGS = [
  'foodtok',
  'asianfoodie',
  'ghostkitchen',
  'restaurantlife',
  'cheflife',
  'foodreels',
  'asianfusion',
  'detroitfood',
  'foodcinema',
  'foodie',
  'foodcontent',
  'detroiteats',
];

// Keyword searches — focused on VIDEO FORMATS, not specific dishes.
// Add/remove terms here. TIKTOK_KEYWORD_MAX controls results per keyword.
const TIKTOK_KEYWORD_SEARCHES = [
  'restaurant viral video',
  'food video format',
  'chef content idea',
  'ghost kitchen',
  'Detroit food',
];

// ─── Instagram sources ────────────────────────────────────────────────────────
// Add handles here. INSTAGRAM_MAX controls results per account/hashtag source.
const INSTAGRAM_ACCOUNTS = [
  'blazincoop',
  'cousinvinnyssandwichco',
  'gordonramsay',
];

// ─── Apify actor IDs ──────────────────────────────────────────────────────────
const TIKTOK_ACTOR    = 'clockworks/tiktok-scraper';
const INSTAGRAM_ACTOR = 'apify/instagram-scraper';

// ─── Per-source limits ────────────────────────────────────────────────────────
// ONE number to change per source type. All actors respect these independently.
const TIKTOK_HASHTAG_MAX = 50;   // results per hashtag scrape run
const TIKTOK_KEYWORD_MAX = 50;   // results per keyword search term
const INSTAGRAM_MAX      = 50;   // results per account or hashtag URL

// Audio flagging threshold — sounds appearing this many times or more are flagged as trending
const TRENDING_SOUND_MIN_COUNT = 3;

// How far back to look (hours)
const HOURS_BACK = 24;

// ─── Apify cost estimate rates ────────────────────────────────────────────────
// Approximate rates based on Apify Pro ($49/100 CU). Adjust if billing differs.
// Check Apify dashboard after each run to calibrate these values.
const COST_PER_TIKTOK_ITEM    = 0.0040;  // USD per scraped TikTok item
const COST_PER_INSTAGRAM_ITEM = 0.0050;  // USD per scraped Instagram item
const COST_PER_ACTOR_START    = 0.0100;  // USD overhead per actor invocation

// ─── Apify client (lazy init) ─────────────────────────────────────────────────
let _client = null;
function client() {
  if (!_client) _client = new ApifyClient({ token: process.env.APIFY_API_KEY });
  return _client;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────
function cutoffMs() {
  return Date.now() - HOURS_BACK * 60 * 60 * 1000;
}

function isWithin24h(postedAt) {
  if (!postedAt) return true;
  const ts = typeof postedAt === 'number'
    ? postedAt * 1000
    : new Date(postedAt).getTime();
  return ts >= cutoffMs();
}

// ─── Actor runner helper ──────────────────────────────────────────────────────
async function runActor(actorId, input, label) {
  logger.info(`[Scraper] Starting: ${label}`);
  try {
    const run = await client().actor(actorId).call(input, { waitSecs: 300 });
    const { items } = await client()
      .dataset(run.defaultDatasetId)
      .listItems({ limit: 1000 });
    logger.info(`[Scraper] ${label} — ${items.length} raw items`);
    return items;
  } catch (err) {
    logger.error(`[Scraper] ${label} — FAILED: ${err.message}`);
    return [];
  }
}

// ─── TikTok: hashtag scraping ─────────────────────────────────────────────────
async function scrapeTikTokHashtags() {
  return runActor(
    TIKTOK_ACTOR,
    {
      type:               'hashtag',
      hashtags:           TRACKED_HASHTAGS,
      resultsPerPage:     TIKTOK_HASHTAG_MAX,
      maxItems:           TIKTOK_HASHTAG_MAX * TRACKED_HASHTAGS.length,
      proxyConfiguration: { useApifyProxy: true },
    },
    `TikTok hashtags (${TRACKED_HASHTAGS.length} tags × ${TIKTOK_HASHTAG_MAX} max each)`
  );
}

// ─── TikTok: keyword search scraping ─────────────────────────────────────────
// Runs one actor call per keyword term, all in parallel. Goal: find viral VIDEO
// FORMATS (not dishes) by looking at what surfaces for these format-focused terms.
async function scrapeTikTokKeywords() {
  const results = await Promise.all(
    TIKTOK_KEYWORD_SEARCHES.map((term) =>
      runActor(
        TIKTOK_ACTOR,
        {
          type:               'search',
          searchQueries:      [term],
          resultsPerPage:     TIKTOK_KEYWORD_MAX,
          maxItems:           TIKTOK_KEYWORD_MAX,
          proxyConfiguration: { useApifyProxy: true },
        },
        `TikTok keyword: "${term}"`
      ).catch((err) => {
        logger.error(`[Scraper] TikTok keyword "${term}" failed: ${err.message}`);
        return [];
      })
    )
  );
  return results.flat();
}

// ─── Instagram: accounts + hashtags ──────────────────────────────────────────
async function scrapeInstagram() {
  const hashtagUrls = TRACKED_HASHTAGS.map(
    (tag) => `https://www.instagram.com/explore/tags/${tag}/`
  );
  const accountUrls = INSTAGRAM_ACCOUNTS.map(
    (handle) => `https://www.instagram.com/${handle}/`
  );

  return runActor(
    INSTAGRAM_ACTOR,
    {
      directUrls:   [...hashtagUrls, ...accountUrls],
      resultsType:  'posts',
      resultsLimit: INSTAGRAM_MAX,
      addParentData: true,
      proxy:        { useApifyProxy: true },
    },
    `Instagram (${TRACKED_HASHTAGS.length} hashtags + ${INSTAGRAM_ACCOUNTS.length} accounts × ${INSTAGRAM_MAX} max each)`
  );
}

// ─── Normalization — TikTok ───────────────────────────────────────────────────
function normalizeTikTok(raw) {
  try {
    const hashtags = (raw.hashtags || [])
      .map((h) => (typeof h === 'string' ? h : h?.name || ''))
      .map((h) => h.replace(/^#/, '').toLowerCase())
      .filter(Boolean);

    return {
      id: raw.id || raw.webVideoUrl || `tt_${Date.now()}_${Math.random()}`,
      platform: 'tiktok',
      url: raw.webVideoUrl || raw.videoUrl || '',
      videoDownloadUrl: raw.videoUrl || raw.videoUrlNoWaterMark || raw.mediaUrls?.[0] || '',
      viewCount:            Number(raw.playCount       || 0),
      likeCount:            Number(raw.diggCount       || raw.likesCount || 0),
      commentCount:         Number(raw.commentCount    || 0),
      shareCount:           Number(raw.shareCount      || 0),
      saveCount:            Number(raw.collectCount    || 0),
      caption:              String(raw.text            || ''),
      hashtags,
      audioName:            raw.musicMeta?.musicName   || raw.music?.title || '',
      audioId:              raw.musicMeta?.musicId     || '',
      videoDuration:        Number(raw.videoMeta?.duration || raw.video?.duration || 0),
      postedAt:             raw.createTime
                              ? new Date(Number(raw.createTime) * 1000).toISOString()
                              : null,
      accountHandle:        raw.authorMeta?.name       || raw.author?.uniqueId || '',
      accountFollowerCount: Number(raw.authorMeta?.fans || raw.authorStats?.followerCount || 0),
      scrapedAt:            new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(`[Scraper] TikTok normalization failed: ${err.message}`);
    return null;
  }
}

// ─── Normalization — Instagram ────────────────────────────────────────────────
// NOTE: Instagram does not publicly expose share or save counts.
// shareCount and saveCount will always be 0. The KPI scorer handles this.
function normalizeInstagram(raw) {
  try {
    let hashtags = (raw.hashtags || [])
      .map((h) => (typeof h === 'string' ? h : ''))
      .map((h) => h.replace(/^#/, '').toLowerCase())
      .filter(Boolean);

    if (hashtags.length === 0 && raw.caption) {
      hashtags = (raw.caption.match(/#(\w+)/g) || [])
        .map((h) => h.replace('#', '').toLowerCase());
    }

    return {
      id: raw.id || raw.shortCode || raw.url || `ig_${Date.now()}_${Math.random()}`,
      platform: 'instagram',
      url: raw.url || '',
      videoDownloadUrl: raw.videoUrl || raw.videoUrlHd || raw.mediaUrls?.[0] || '',
      viewCount:            Number(raw.videoViewCount || raw.videoPlayCount || raw.likesCount || 0),
      likeCount:            Number(raw.likesCount     || 0),
      commentCount:         Number(raw.commentsCount  || 0),
      shareCount:           0,  // not exposed by Instagram
      saveCount:            0,  // not exposed by Instagram
      caption:              String(raw.caption        || ''),
      hashtags,
      audioName:            raw.musicInfo?.songName   || raw.musicName || '',
      audioId:              raw.musicInfo?.musicId    || '',
      videoDuration:        Number(raw.videoDuration  || 0),
      postedAt:             raw.timestamp
                              ? new Date(raw.timestamp).toISOString()
                              : null,
      accountHandle:        raw.ownerUsername         || '',
      accountFollowerCount: Number(raw.ownerFollowersCount || 0),
      scrapedAt:            new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(`[Scraper] Instagram normalization failed: ${err.message}`);
    return null;
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────
function deduplicate(videos) {
  const seen = new Set();
  return videos.filter((v) => {
    const key = v.url || v.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Trending sound detection ─────────────────────────────────────────────────
// Runs over the full merged dataset (all platforms, all sources).
// Returns the top 5 audio tracks by appearance count.
// Sounds meeting TRENDING_SOUND_MIN_COUNT are flagged as trending.
function detectTrendingSounds(videos) {
  const counts = {};
  for (const v of videos) {
    const name = (v.audioName || '').trim();
    if (!name || /^original.?sound$/i.test(name)) continue;
    counts[name] = (counts[name] || 0) + 1;
  }

  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([audioName, videoCount]) => ({
      audioName,
      videoCount,
      trending: videoCount >= TRENDING_SOUND_MIN_COUNT,
    }));

  const flagged = ranked.filter((s) => s.trending);

  logger.info(`[Scraper] ── Trending sounds ─────────────────────────────`);
  if (ranked.length === 0) {
    logger.info(`[Scraper]    No named audio detected`);
  } else {
    ranked.forEach((s) => {
      const flag = s.trending ? ' ← TRENDING' : '';
      logger.info(`[Scraper]    "${s.audioName}" — ${s.videoCount} video(s)${flag}`);
    });
  }
  logger.info(`[Scraper]    ${flagged.length} sound(s) flagged as trending (≥${TRENDING_SOUND_MIN_COUNT} videos)`);

  return ranked;
}

// ─── Apify cost estimate ──────────────────────────────────────────────────────
function logCostEstimate(counts) {
  // Actor invocation counts: 1 hashtag run + 5 keyword runs + 1 Instagram run
  const actorCalls = 1 + TIKTOK_KEYWORD_SEARCHES.length + 1;

  const tiktokCost    = counts.tiktokTotal    * COST_PER_TIKTOK_ITEM;
  const instagramCost = counts.instagramTotal * COST_PER_INSTAGRAM_ITEM;
  const startupCost   = actorCalls            * COST_PER_ACTOR_START;
  const totalCost     = tiktokCost + instagramCost + startupCost;

  logger.info(`[Scraper] ── Apify cost estimate (approximate) ───────────`);
  logger.info(`[Scraper]    TikTok:   ${counts.tiktokHashtag} hashtag + ${counts.tiktokKeyword} keyword items  ≈ $${tiktokCost.toFixed(3)}`);
  logger.info(`[Scraper]    Instagram: ${counts.instagramTotal} items  ≈ $${instagramCost.toFixed(3)}`);
  logger.info(`[Scraper]    Actor starts: ${actorCalls} calls  ≈ $${startupCost.toFixed(3)}`);
  logger.info(`[Scraper]    Total estimated: ~$${totalCost.toFixed(2)} per run`);
  logger.info(`[Scraper]    (Rates: $${COST_PER_TIKTOK_ITEM}/TT item, $${COST_PER_INSTAGRAM_ITEM}/IG item, $${COST_PER_ACTOR_START}/start)`);
  logger.info(`[Scraper]    Verify against Apify dashboard to calibrate these estimates.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(dateString) {
  const outputPath = path.join(DATA_DIR, 'raw-data', `${dateString}.json`);

  logger.info('[Scraper] ─────────────────────────────────────────────────');
  logger.info('[Scraper] Launching all scrapers in parallel');
  logger.info(`[Scraper] TikTok hashtags:  ${TRACKED_HASHTAGS.map((h) => '#' + h).join(', ')}`);
  logger.info(`[Scraper] TikTok keywords:  ${TIKTOK_KEYWORD_SEARCHES.map((t) => `"${t}"`).join(', ')}`);
  logger.info(`[Scraper] Instagram:        hashtags above + accounts: ${INSTAGRAM_ACCOUNTS.join(', ')}`);
  logger.info(`[Scraper] Limits:           ${TIKTOK_HASHTAG_MAX}/hashtag  ${TIKTOK_KEYWORD_MAX}/keyword  ${INSTAGRAM_MAX}/IG source`);
  logger.info('[Scraper] ─────────────────────────────────────────────────');

  // ── Fire TikTok hashtags, TikTok keywords, and Instagram simultaneously ────
  const [tiktokHashtagRaw, tiktokKeywordRaw, instagramRaw] = await Promise.all([
    scrapeTikTokHashtags().catch((err) => {
      logger.error(`[Scraper] TikTok hashtag top-level error: ${err.message}`);
      return [];
    }),
    scrapeTikTokKeywords().catch((err) => {
      logger.error(`[Scraper] TikTok keyword top-level error: ${err.message}`);
      return [];
    }),
    scrapeInstagram().catch((err) => {
      logger.error(`[Scraper] Instagram top-level error: ${err.message}`);
      return [];
    }),
  ]);

  // ── Normalize ──────────────────────────────────────────────────────────────
  const tiktokHashtagVideos = tiktokHashtagRaw.map(normalizeTikTok).filter(Boolean);
  const tiktokKeywordVideos = tiktokKeywordRaw.map(normalizeTikTok).filter(Boolean);
  const instagramVideos     = instagramRaw.map(normalizeInstagram).filter(Boolean);
  const allVideos           = deduplicate([...tiktokHashtagVideos, ...tiktokKeywordVideos, ...instagramVideos]);

  // ── Filter to 24h window ───────────────────────────────────────────────────
  const recentVideos = allVideos.filter((v) => isWithin24h(v.postedAt));
  const filteredOut  = allVideos.length - recentVideos.length;

  logger.info(`[Scraper] TikTok hashtag normalized:  ${tiktokHashtagVideos.length}`);
  logger.info(`[Scraper] TikTok keyword normalized:  ${tiktokKeywordVideos.length}`);
  logger.info(`[Scraper] Instagram normalized:       ${instagramVideos.length}`);
  logger.info(`[Scraper] Total unique:               ${allVideos.length}`);
  logger.info(`[Scraper] Within 24h window:          ${recentVideos.length} (removed ${filteredOut} older)`);

  // ── Detect trending sounds across full dataset ─────────────────────────────
  const trendingSounds = detectTrendingSounds(recentVideos);

  // ── Cost estimate ──────────────────────────────────────────────────────────
  logCostEstimate({
    tiktokHashtag:  tiktokHashtagVideos.length,
    tiktokKeyword:  tiktokKeywordVideos.length,
    tiktokTotal:    tiktokHashtagVideos.length + tiktokKeywordVideos.length,
    instagramTotal: instagramVideos.length,
  });

  // ── Save raw data ──────────────────────────────────────────────────────────
  const output = {
    date:             dateString,
    scrapedAt:        new Date().toISOString(),
    totalVideos:      recentVideos.length,
    tiktokCount:      recentVideos.filter((v) => v.platform === 'tiktok').length,
    instagramCount:   recentVideos.filter((v) => v.platform === 'instagram').length,
    tiktokHashtags:   TRACKED_HASHTAGS,
    tiktokKeywords:   TIKTOK_KEYWORD_SEARCHES,
    instagramAccounts: INSTAGRAM_ACCOUNTS,
    trendingSounds,
    note: 'Instagram shareCount and saveCount are always 0 — not exposed by the platform.',
    videos: recentVideos,
  };

  await fse.ensureDir(path.dirname(outputPath));
  await fse.writeJson(outputPath, output, { spaces: 2 });
  logger.info(`[Scraper] Raw data saved → ${outputPath}`);
  logger.info('[Scraper] ─────────────────────────────────────────────────');

  return { videos: recentVideos, trendingSounds };
}

module.exports = { run, TRACKED_HASHTAGS, INSTAGRAM_ACCOUNTS, TIKTOK_KEYWORD_SEARCHES };
