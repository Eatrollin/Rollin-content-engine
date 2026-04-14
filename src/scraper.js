require('dotenv').config();

const { ApifyClient } = require('apify-client');
const fse = require('fs-extra');
const path = require('path');
const logger = require('./logger');

// ─── Brand config ─────────────────────────────────────────────────────────────
// TikTok: hashtag scraping only (account scraping removed — unreliable)
// Instagram: accounts + hashtags. Add handles to INSTAGRAM_ACCOUNTS to benchmark specific creators.

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

const INSTAGRAM_ACCOUNTS = [
  'blazincoop',
  'cousinvinnyssandwichco',
];

// ─── Apify actor IDs ──────────────────────────────────────────────────────────
const TIKTOK_ACTOR   = 'clockworks/tiktok-scraper';
const INSTAGRAM_ACTOR = 'apify/instagram-scraper';

// Max items per scrape call — controls Apify credit usage
const TIKTOK_HASHTAG_MAX  = 150;
const INSTAGRAM_MAX       = 100;

// How far back to look (hours)
const HOURS_BACK = 24;

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
  if (!postedAt) return true; // include if timestamp unknown
  const ts = typeof postedAt === 'number'
    ? postedAt * 1000
    : new Date(postedAt).getTime();
  return ts >= cutoffMs();
}

// ─── Actor runner helper ──────────────────────────────────────────────────────
async function runActor(actorId, input, label) {
  logger.info(`[Scraper] Starting actor: ${label}`);
  try {
    const run = await client().actor(actorId).call(input, { waitSecs: 300 });
    const { items } = await client()
      .dataset(run.defaultDatasetId)
      .listItems({ limit: 1000 });
    logger.info(`[Scraper] ${label} — returned ${items.length} raw items`);
    return items;
  } catch (err) {
    logger.error(`[Scraper] ${label} — FAILED: ${err.message}`);
    return [];
  }
}

// ─── TikTok ───────────────────────────────────────────────────────────────────
async function scrapeTikTok() {
  logger.info('[Scraper] TikTok: hashtag scraping only...');

  const items = await runActor(
    TIKTOK_ACTOR,
    {
      type: 'hashtag',
      hashtags: TRACKED_HASHTAGS,
      resultsPerPage: TIKTOK_HASHTAG_MAX,
      maxItems: TIKTOK_HASHTAG_MAX,
      proxyConfiguration: { useApifyProxy: true },
    },
    `TikTok hashtags [${TRACKED_HASHTAGS.join(', ')}]`
  );

  return items;
}

// ─── Instagram ────────────────────────────────────────────────────────────────
async function scrapeInstagram() {
  logger.info('[Scraper] Instagram: launching scraper for hashtags + accounts...');

  const hashtagUrls = TRACKED_HASHTAGS.map(
    (tag) => `https://www.instagram.com/explore/tags/${tag}/`
  );
  const accountUrls = INSTAGRAM_ACCOUNTS.map(
    (handle) => `https://www.instagram.com/${handle}/`
  );

  const items = await runActor(
    INSTAGRAM_ACTOR,
    {
      directUrls: [...hashtagUrls, ...accountUrls],
      resultsType: 'posts',
      resultsLimit: INSTAGRAM_MAX,
      addParentData: true,
      proxy: { useApifyProxy: true },
    },
    `Instagram [${TRACKED_HASHTAGS.length} hashtags + ${INSTAGRAM_ACCOUNTS.length} accounts]`
  );

  return items;
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
      viewCount:         Number(raw.playCount       || 0),
      likeCount:         Number(raw.diggCount       || raw.likesCount || 0),
      commentCount:      Number(raw.commentCount    || 0),
      shareCount:        Number(raw.shareCount      || 0),
      saveCount:         Number(raw.collectCount    || 0),
      caption:           String(raw.text            || ''),
      hashtags,
      audioName:         raw.musicMeta?.musicName   || raw.music?.title || '',
      audioId:           raw.musicMeta?.musicId     || '',
      videoDuration:     Number(raw.videoMeta?.duration || raw.video?.duration || 0),
      postedAt:          raw.createTime
                           ? new Date(Number(raw.createTime) * 1000).toISOString()
                           : null,
      accountHandle:     raw.authorMeta?.name       || raw.author?.uniqueId || '',
      accountFollowerCount: Number(raw.authorMeta?.fans || raw.authorStats?.followerCount || 0),
      scrapedAt:         new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(`[Scraper] TikTok normalization failed for item: ${err.message}`);
    return null;
  }
}

// ─── Normalization — Instagram ────────────────────────────────────────────────
// NOTE: Instagram does not publicly expose share or save counts.
// shareCount and saveCount will always be 0 for Instagram items.
// The KPI scorer weights these as 0 and adjusts accordingly.
function normalizeInstagram(raw) {
  try {
    let hashtags = (raw.hashtags || [])
      .map((h) => (typeof h === 'string' ? h : ''))
      .map((h) => h.replace(/^#/, '').toLowerCase())
      .filter(Boolean);

    // Fall back to parsing caption if hashtag array is empty
    if (hashtags.length === 0 && raw.caption) {
      hashtags = (raw.caption.match(/#(\w+)/g) || [])
        .map((h) => h.replace('#', '').toLowerCase());
    }

    return {
      id: raw.id || raw.shortCode || raw.url || `ig_${Date.now()}_${Math.random()}`,
      platform: 'instagram',
      url: raw.url || '',
      videoDownloadUrl: raw.videoUrl || raw.videoUrlHd || raw.mediaUrls?.[0] || '',
      viewCount:         Number(raw.videoViewCount || raw.videoPlayCount || raw.likesCount || 0),
      likeCount:         Number(raw.likesCount     || 0),
      commentCount:      Number(raw.commentsCount  || 0),
      shareCount:        0,  // not exposed by Instagram
      saveCount:         0,  // not exposed by Instagram
      caption:           String(raw.caption        || ''),
      hashtags,
      audioName:         raw.musicInfo?.songName   || raw.musicName || '',
      audioId:           raw.musicInfo?.musicId    || '',
      videoDuration:     Number(raw.videoDuration  || 0),
      postedAt:          raw.timestamp
                           ? new Date(raw.timestamp).toISOString()
                           : null,
      accountHandle:     raw.ownerUsername         || '',
      accountFollowerCount: Number(raw.ownerFollowersCount || 0),
      scrapedAt:         new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(`[Scraper] Instagram normalization failed for item: ${err.message}`);
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

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(dateString) {
  const outputPath = path.join(__dirname, '..', 'raw-data', `${dateString}.json`);

  logger.info('[Scraper] ─────────────────────────────────────────────');
  logger.info('[Scraper] Launching TikTok + Instagram scrapers in parallel');
  logger.info(`[Scraper] TikTok: hashtags only — ${TRACKED_HASHTAGS.map(h => '#' + h).join(', ')}`);
  logger.info(`[Scraper] Instagram: ${TRACKED_HASHTAGS.length} hashtags + accounts: ${INSTAGRAM_ACCOUNTS.join(', ') || 'none'}`);
  logger.info('[Scraper] ─────────────────────────────────────────────');

  // ── Scrape both platforms simultaneously ───────────────────────────────────
  const [tiktokRaw, instagramRaw] = await Promise.all([
    scrapeTikTok().catch((err) => {
      logger.error(`[Scraper] TikTok top-level error: ${err.message}`);
      return [];
    }),
    scrapeInstagram().catch((err) => {
      logger.error(`[Scraper] Instagram top-level error: ${err.message}`);
      return [];
    }),
  ]);

  // ── Normalize ──────────────────────────────────────────────────────────────
  const tiktokVideos    = tiktokRaw.map(normalizeTikTok).filter(Boolean);
  const instagramVideos = instagramRaw.map(normalizeInstagram).filter(Boolean);
  const allVideos       = deduplicate([...tiktokVideos, ...instagramVideos]);

  // ── Filter to 24h window ───────────────────────────────────────────────────
  const recentVideos = allVideos.filter((v) => isWithin24h(v.postedAt));
  const filteredOut  = allVideos.length - recentVideos.length;

  logger.info(`[Scraper] TikTok normalized:    ${tiktokVideos.length}`);
  logger.info(`[Scraper] Instagram normalized:  ${instagramVideos.length}`);
  logger.info(`[Scraper] Total unique:          ${allVideos.length}`);
  logger.info(`[Scraper] Within 24h window:     ${recentVideos.length} (removed ${filteredOut} older)`);

  // ── Save raw data ──────────────────────────────────────────────────────────
  const output = {
    date:            dateString,
    scrapedAt:       new Date().toISOString(),
    totalVideos:     recentVideos.length,
    tiktokCount:     recentVideos.filter((v) => v.platform === 'tiktok').length,
    instagramCount:  recentVideos.filter((v) => v.platform === 'instagram').length,
    tiktokHashtags:    TRACKED_HASHTAGS,
    instagramAccounts: INSTAGRAM_ACCOUNTS,
    note: 'Instagram shareCount and saveCount are always 0 — not exposed by the platform.',
    videos:          recentVideos,
  };

  await fse.ensureDir(path.dirname(outputPath));
  await fse.writeJson(outputPath, output, { spaces: 2 });
  logger.info(`[Scraper] Raw data saved → ${outputPath}`);

  return recentVideos;
}

module.exports = { run, TRACKED_HASHTAGS, INSTAGRAM_ACCOUNTS };
