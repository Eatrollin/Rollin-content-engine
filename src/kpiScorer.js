require('dotenv').config();

const logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// BASE KPI WEIGHTS — TikTok only
// Spec: share rate 50%, save rate 30%, comment rate 20%
// ─────────────────────────────────────────────────────────────────────────────
const BASE_WEIGHTS = {
  shareRate:   0.50,
  saveRate:    0.30,
  commentRate: 0.20,
};

// Dynamic signal weights (combined into a 0-1 supplement score)
const DYNAMIC_WEIGHTS = {
  velocity:    0.40,  // views per hour since posted — strongest real-time signal
  audioReuse:  0.25,
  hashtag:     0.15,
  postingTime: 0.10,
  captionCTA:  0.10,  // caption contains engagement trigger language
};

// Base KPI carries 70% of composite; dynamic signals carry 30%
const COMPOSITE_WEIGHTS = {
  base:    0.70,
  dynamic: 0.30,
};

// ─────────────────────────────────────────────────────────────────────────────
// BASE KPI — TikTok hardcoded formula, never changes
// ─────────────────────────────────────────────────────────────────────────────
function calcBaseKpi(video) {
  const views = video.viewCount || 0;

  if (views === 0) {
    return {
      shareRate:    0,
      saveRate:     0,
      commentRate:  0,
      baseKpiScore: 0,
      kpiSignals:   ['zero-views'],
    };
  }

  const shareRate   = (video.shareCount   || 0) / views;
  const saveRate    = (video.saveCount    || 0) / views;
  const commentRate = (video.commentCount || 0) / views;

  const baseKpiScore =
    shareRate   * BASE_WEIGHTS.shareRate   +
    saveRate    * BASE_WEIGHTS.saveRate    +
    commentRate * BASE_WEIGHTS.commentRate;

  const kpiSignals = [];
  if (shareRate   > 0) kpiSignals.push('share-rate');
  if (saveRate    > 0) kpiSignals.push('save-rate');
  if (commentRate > 0) kpiSignals.push('comment-rate');
  if (kpiSignals.length === 0) kpiSignals.push('views-only-no-engagement');

  return { shareRate, saveRate, commentRate, baseKpiScore, kpiSignals };
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC KPI 1 — Engagement velocity
// ─────────────────────────────────────────────────────────────────────────────
function calcVelocity(video) {
  if (!video.postedAt) {
    return { engagementVelocity: 0, totalEngagement: 0, ageHours: null };
  }

  const totalEngagement =
    (video.likeCount    || 0) +
    (video.commentCount || 0) +
    (video.shareCount   || 0) +
    (video.saveCount    || 0);

  const ageMs    = Date.now() - new Date(video.postedAt).getTime();
  const ageHours = Math.max(ageMs / (1000 * 60 * 60), 0.5);

  const engagementVelocity = totalEngagement / ageHours;

  return { engagementVelocity, totalEngagement, ageHours };
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC KPI 2 — Audio reuse map
// ─────────────────────────────────────────────────────────────────────────────
function buildAudioReuseMap(videos) {
  const map = {};
  for (const v of videos) {
    const key = (v.audioId || v.audioName || '').trim();
    if (!key) continue;
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC KPI 3 — Hashtag frequency map
// ─────────────────────────────────────────────────────────────────────────────
function buildHashtagFreqMap(videos) {
  const map = {};
  for (const v of videos) {
    for (const tag of v.hashtags || []) {
      const key = tag.toLowerCase();
      map[key] = (map[key] || 0) + 1;
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC KPI 4 — Posting time correlation
// ─────────────────────────────────────────────────────────────────────────────
function buildPostingTimeMap(videos) {
  const groups = {};

  for (const v of videos) {
    if (!v.postedAt) continue;
    const hour = new Date(v.postedAt).getHours();
    if (!groups[hour]) groups[hour] = { total: 0, count: 0 };

    const eng =
      (v.likeCount    || 0) +
      (v.commentCount || 0) +
      (v.shareCount   || 0) +
      (v.saveCount    || 0);

    groups[hour].total += eng;
    groups[hour].count += 1;
  }

  const avgByHour = {};
  for (const [hour, data] of Object.entries(groups)) {
    avgByHour[hour] = data.count > 0 ? data.total / data.count : 0;
  }
  return avgByHour;
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC KPI 5 — Caption CTA signal
// ─────────────────────────────────────────────────────────────────────────────
function calcCaptionCTA(video) {
  const triggers = ['?', 'comment', 'save', 'share', 'tag', 'drop', 'tell me', 'which', 'link in bio', 'follow'];
  const caption = (video.caption || '').toLowerCase();
  return triggers.some((t) => caption.includes(t)) ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function normalize(values) {
  const nums  = values.map((v) => (v === null || isNaN(v) ? 0 : v));
  const min   = Math.min(...nums);
  const max   = Math.max(...nums);
  const range = max - min;
  return nums.map((v) => (range === 0 ? 0 : (v - min) / range));
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — score all videos
// ─────────────────────────────────────────────────────────────────────────────
function score(videos) {
  if (!videos || videos.length === 0) {
    logger.warn('[KPI] No videos to score — returning empty array.');
    return [];
  }

  logger.info(`[KPI] Scoring ${videos.length} videos...`);

  const instagramCount = videos.filter((v) => v.platform === 'instagram').length;
  if (instagramCount > 0) {
    logger.info(
      `[KPI] Note: ${instagramCount} Instagram videos scored with dedicated Instagram formula ` +
      `(view score, comment rate, like rate, audio reuse, hashtag frequency, caption CTA).`
    );
  }

  // Median views for Instagram view-score normalization
  const igViewCounts  = videos.filter((v) => v.platform === 'instagram').map((v) => v.viewCount || 0);
  const medianIgViews = median(igViewCounts);

  // ── Pre-compute lookup tables for dynamic signals ────────────────────────
  const audioReuseMap  = buildAudioReuseMap(videos);
  const hashtagFreqMap = buildHashtagFreqMap(videos);
  const postingTimeMap = buildPostingTimeMap(videos);

  // Log trending audio (3+ videos sharing same sound)
  const trendingAudio = Object.entries(audioReuseMap)
    .filter(([, count]) => count >= 3)
    .sort(([, a], [, b]) => b - a);
  if (trendingAudio.length > 0) {
    logger.info(`[KPI] Trending audio detected in dataset:`);
    trendingAudio.forEach(([name, count]) =>
      logger.info(`[KPI]   "${name}" — ${count} videos`)
    );
  }

  // Log top posting hours
  const topHours = Object.entries(postingTimeMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  if (topHours.length > 0) {
    logger.info(
      `[KPI] Top performing post hours: ` +
      topHours.map(([h, avg]) => `${h}:00 (avg ${Math.round(avg)} eng)`).join(', ')
    );
  }

  // ── Pass 1: calculate raw scores for every video ─────────────────────────
  const rawScores = videos.map((v) => {
    const base     = calcBaseKpi(v);
    const velocity = calcVelocity(v);

    const audioKey        = (v.audioId || v.audioName || '').trim();
    const audioReuseCount = audioReuseMap[audioKey] || 0;

    const tags = v.hashtags || [];
    const hashtagScore = tags.length > 0
      ? tags.reduce((sum, t) => sum + (hashtagFreqMap[t.toLowerCase()] || 0), 0) / tags.length
      : 0;

    const postHour       = v.postedAt ? new Date(v.postedAt).getHours() : null;
    const postingTimeAvg = postHour !== null ? (postingTimeMap[postHour] || 0) : 0;

    // Instagram-specific base KPI components
    const views    = v.viewCount || 0;
    const viewScore = v.platform === 'instagram'
      ? Math.min(views / Math.max(medianIgViews, 1), 1.0)
      : 0;
    const likeRate = views > 0 ? (v.likeCount || 0) / views : 0;

    const captionCTA = calcCaptionCTA(v);

    return {
      ...base,
      engagementVelocity: velocity.engagementVelocity,
      totalEngagement:    velocity.totalEngagement,
      ageHours:           velocity.ageHours,
      audioReuseCount,
      hashtagScore,
      postingTimeAvg,
      viewScore,
      likeRate,
      captionCTA,
    };
  });

  // ── Pass 2: normalize dynamic signals 0–1 across the full dataset ────────
  const normVelocity   = normalize(rawScores.map((s) => s.engagementVelocity));
  const normAudio      = normalize(rawScores.map((s) => s.audioReuseCount));
  const normHashtag    = normalize(rawScores.map((s) => s.hashtagScore));
  const normPostTime   = normalize(rawScores.map((s) => s.postingTimeAvg));
  const normCaptionCTA = normalize(rawScores.map((s) => s.captionCTA));

  // ── Pass 3: compute composite score and attach full kpi block ────────────
  const scored = videos.map((v, i) => {
    const s = rawScores[i];

    // Platform-aware base KPI
    let baseKpiScore;
    if (v.platform === 'instagram') {
      baseKpiScore =
        s.viewScore    * 0.25 +
        s.commentRate  * 0.20 +
        s.likeRate     * 0.15 +
        normAudio[i]   * 0.10 +
        normHashtag[i] * 0.10 +
        s.captionCTA   * 0.05;
    } else {
      baseKpiScore = s.baseKpiScore;
    }

    const dynamicScore =
      normVelocity[i]   * DYNAMIC_WEIGHTS.velocity    +
      normAudio[i]      * DYNAMIC_WEIGHTS.audioReuse  +
      normHashtag[i]    * DYNAMIC_WEIGHTS.hashtag     +
      normPostTime[i]   * DYNAMIC_WEIGHTS.postingTime +
      normCaptionCTA[i] * DYNAMIC_WEIGHTS.captionCTA;

    const compositeScore =
      baseKpiScore * COMPOSITE_WEIGHTS.base +
      dynamicScore * COMPOSITE_WEIGHTS.dynamic;

    const kpiSignalsMatched = [...s.kpiSignals];
    if (s.audioReuseCount >= 3)   kpiSignalsMatched.push('trending-audio');
    else if (s.audioReuseCount >= 2) kpiSignalsMatched.push('shared-audio');
    if (normVelocity[i]   > 0.70) kpiSignalsMatched.push('high-velocity');
    if (normHashtag[i]    > 0.70) kpiSignalsMatched.push('hashtag-frequency-spike');
    if (normPostTime[i]   > 0.70) kpiSignalsMatched.push('peak-posting-time');
    if (normCaptionCTA[i] > 0.5)  kpiSignalsMatched.push('caption-cta');

    return {
      ...v,
      kpi: {
        // ── Base KPI ───────────────────────────────────────────────────────
        shareRate:             round6(s.shareRate),
        saveRate:              round6(s.saveRate),
        commentRate:           round6(s.commentRate),
        likeRate:              round6(s.likeRate),
        viewScore:             round6(s.viewScore),
        baseKpiScore:          round6(baseKpiScore),

        // ── Dynamic signals (normalized 0–1) ───────────────────────────────
        engagementVelocity:    round6(s.engagementVelocity),
        ageHours:              s.ageHours !== null ? round6(s.ageHours) : null,
        totalEngagement:       s.totalEngagement || 0,
        velocityNormalized:    round6(normVelocity[i]),
        audioReuseCount:       s.audioReuseCount,
        audioReuseName:        v.audioName || '',
        audioReuseNormalized:  round6(normAudio[i]),
        hashtagFreqNormalized: round6(normHashtag[i]),
        postingTimeNormalized: round6(normPostTime[i]),
        captionCTA:            s.captionCTA,
        captionCTANormalized:  round6(normCaptionCTA[i]),

        // ── Composite ──────────────────────────────────────────────────────
        dynamicScore:          round6(dynamicScore),
        compositeScore:        round6(compositeScore),

        // ── Metadata ───────────────────────────────────────────────────────
        kpiSignalsMatched,
        passedKpiThreshold:    false, // resolved in pass 4
        medianBaseKpiScore:    0,     // filled in pass 4
        instagramDataLimited:  v.platform === 'instagram',
      },
    };
  });

  // ── Pass 4: compute threshold (40th percentile = top 60% pass) ──────────
  const baseScores     = scored.map((v) => v.kpi.baseKpiScore);
  const medianScore    = round6(median(baseScores));
  const thresholdScore = round6(percentile(baseScores, 40));

  let passed = 0;
  for (const v of scored) {
    v.kpi.medianBaseKpiScore = medianScore;
    v.kpi.passedKpiThreshold = v.kpi.baseKpiScore > thresholdScore;
    if (v.kpi.passedKpiThreshold) passed++;
  }

  // ── Sort by composite score descending ───────────────────────────────────
  scored.sort((a, b) => b.kpi.compositeScore - a.kpi.compositeScore);

  // ── Summary ───────────────────────────────────────────────────────────────
  const tiktokPassed        = scored.filter((v) => v.platform === 'tiktok'    && v.kpi.passedKpiThreshold).length;
  const instagramPassed     = scored.filter((v) => v.platform === 'instagram' && v.kpi.passedKpiThreshold).length;
  const trendingAudioVideos = scored.filter((v) => v.kpi.kpiSignalsMatched.includes('trending-audio')).length;
  const highVelocity        = scored.filter((v) => v.kpi.kpiSignalsMatched.includes('high-velocity')).length;
  const captionCTAVideos    = scored.filter((v) => v.kpi.kpiSignalsMatched.includes('caption-cta')).length;

  logger.info(`[KPI] Median base KPI score:        ${medianScore}`);
  logger.info(`[KPI] Threshold (40th pctile):      ${thresholdScore}`);
  logger.info(`[KPI] Passed threshold:             ${passed}/${scored.length}`);
  logger.info(`[KPI]   └─ TikTok passed:           ${tiktokPassed}`);
  logger.info(`[KPI]   └─ Instagram passed:        ${instagramPassed}`);
  logger.info(`[KPI] Trending audio signal:        ${trendingAudioVideos} videos`);
  logger.info(`[KPI] High velocity signal:         ${highVelocity} videos`);
  logger.info(`[KPI] Caption CTA signal:           ${captionCTAVideos} videos`);
  logger.info(`[KPI] Top composite score:          ${scored[0]?.kpi.compositeScore ?? 'n/a'}`);
  logger.info(`[KPI] Top video:                    @${scored[0]?.accountHandle ?? 'unknown'} — ${scored[0]?.url ?? ''}`);
  logger.info('[KPI] Scoring complete.');

  return scored;
}

module.exports = { score, BASE_WEIGHTS, COMPOSITE_WEIGHTS };
