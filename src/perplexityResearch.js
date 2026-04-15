const axios  = require('axios');
const logger = require('./logger');

const PERPLEXITY_URL     = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL   = 'sonar';
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Extract signals from raw scraped videos (no KPI scores yet) ──────────────
// Runs before KPI scoring, so uses raw engagement rate as the performance proxy.
function extractSignals(videos) {
  // Sort by raw engagement rate: (shares + saves + comments) / views
  const byEngagement = [...videos].sort((a, b) => {
    const rateA = ((a.shareCount || 0) + (a.saveCount || 0) + (a.commentCount || 0)) / Math.max(a.viewCount || 1, 1);
    const rateB = ((b.shareCount || 0) + (b.saveCount || 0) + (b.commentCount || 0)) / Math.max(b.viewCount || 1, 1);
    return rateB - rateA;
  });
  const top = byEngagement.slice(0, 30);

  // Hashtag frequency across all videos
  const hashtagCounts = {};
  for (const v of videos) {
    for (const tag of (v.hashtags || [])) {
      const t = tag.toLowerCase().replace(/^#/, '').trim();
      if (t.length > 1) hashtagCounts[t] = (hashtagCounts[t] || 0) + 1;
    }
  }
  const topHashtags = Object.entries(hashtagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag]) => tag);

  // Audio names — require 2+ uses, skip "original sound"
  const audioCounts = {};
  for (const v of videos) {
    const name = (v.audioName || '').trim();
    if (name && !/^original.?sound$/i.test(name)) {
      audioCounts[name] = (audioCounts[name] || 0) + 1;
    }
  }
  const topAudios = Object.entries(audioCounts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  // Top performing accounts (unique, from highest engagement-rate videos)
  const topAccounts = [...new Set(top.map((v) => v.accountHandle))]
    .filter(Boolean)
    .slice(0, 5);

  // Keywords from captions of the top 20 videos (strip stop words)
  const STOP = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'is','it','this','that','my','me','you','we','our','from','by','are',
    'was','be','have','has','get','not','so','up','out','just','like','new',
    'all','can','will','more','when','how','what','one','two','day','come',
    'going','make','know','want','here','now','some','been','would','could',
    'using','also','than','then','only','them','they','over','after','about',
    'into','its','their','your',
  ]);
  const wordCounts = {};
  for (const v of top.slice(0, 20)) {
    const words = (v.caption || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w));
    for (const w of words) wordCounts[w] = (wordCounts[w] || 0) + 1;
  }
  const topKeywords = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  const tiktokAbove = top.filter((v) => v.platform === 'tiktok').length;
  const igAbove     = top.filter((v) => v.platform === 'instagram').length;

  return { topHashtags, topAudios, topAccounts, topKeywords, tiktokAbove, igAbove, topVideosCount: top.length };
}

// ─── Build 5 dynamic search prompts from the day's signals ────────────────────
function buildPrompts(signals, dateString) {
  const { topHashtags, topAudios, topAccounts, topKeywords, tiktokAbove, igAbove } = signals;
  const year    = dateString.slice(0, 4);
  const prompts = [];

  // 1 — Top trending hashtag's content strategy
  if (topHashtags.length > 0) {
    const tag = topHashtags[0];
    prompts.push(
      `What food content formats are going viral on TikTok and Instagram using #${tag} in ${year}? ` +
      `What visual styles, video lengths, and storytelling approaches are getting the most engagement? ` +
      `Give specific examples of what the highest-performing creators are doing differently.`
    );
  } else {
    prompts.push(
      `What food content formats are performing best on TikTok and Instagram in ${year}? ` +
      `Focus on ghost kitchens, delivery-first restaurants, and premium fast-casual concepts.`
    );
  }

  // 2 — Audio/sound trend
  if (topAudios.length > 0) {
    const audio = topAudios[0];
    prompts.push(
      `Why is the audio "${audio}" appearing so heavily in food content on TikTok right now? ` +
      `What type of food videos perform best with this sound, and why does it work psychologically? ` +
      `What does pairing this audio with premium Asian fusion food content look like in practice?`
    );
  } else {
    prompts.push(
      `What audio and music trends are driving the highest engagement in food content on TikTok and Instagram in ${year}? ` +
      `What sounds work best for premium restaurant branding versus casual food content? ` +
      `Include specific song names or audio styles that are trending right now.`
    );
  }

  // 3 — Top performing account's content strategy
  if (topAccounts.length > 0) {
    const account = topAccounts[0];
    prompts.push(
      `Analyze the content strategy of @${account} on TikTok and Instagram. ` +
      `What specific tactics — posting frequency, video format, hooks, caption style, visual approach — ` +
      `are driving their high engagement? What can a new premium ghost kitchen launching in Detroit learn ` +
      `from their approach, and what should be avoided or adapted?`
    );
  } else {
    prompts.push(
      `What are the top 5 food and restaurant accounts on TikTok and Instagram right now by engagement rate, not follower count? ` +
      `What content strategies do they share in common, and what can a premium ghost kitchen launching in Detroit in ${year} ` +
      `realistically replicate in their first 30 days?`
    );
  }

  // 4 — Caption language / keyword pattern
  if (topKeywords.length >= 2) {
    const kw1 = topKeywords[0];
    const kw2 = topKeywords[1];
    prompts.push(
      `Why are words like "${kw1}" and "${kw2}" appearing so often in high-performing food content captions right now? ` +
      `What psychological or algorithmic factors make this language effective in food marketing in ${year}? ` +
      `How should a premium Asian fusion ghost kitchen launching in Detroit use this language — ` +
      `and what caption mistakes are killing reach for food brands?`
    );
  } else if (topKeywords.length === 1) {
    prompts.push(
      `Why is "${topKeywords[0]}" such effective language in food content captions on TikTok and Instagram right now? ` +
      `What emotional triggers or platform mechanics make it perform well, and how should a new restaurant brand use it?`
    );
  } else {
    prompts.push(
      `What caption writing strategies are driving the most saves and shares on food content in ${year}? ` +
      `Specific hooks, language patterns, and calls to action that are working right now for restaurant brands on TikTok and Instagram.`
    );
  }

  // 5 — Platform format trend (weighted toward the day's dominant platform)
  const platform   = tiktokAbove >= igAbove ? 'TikTok' : 'Instagram';
  const contextTag = topHashtags[1] || topHashtags[0] || 'asianfusion';
  prompts.push(
    `What content format innovations are driving outsized engagement on ${platform} for food brands right now in ${year}? ` +
    `Focus on: video length sweet spots, trending edit styles, transition formats, and how creators using ` +
    `#${contextTag} are standing out from the noise. ` +
    `What should a premium ghost kitchen launching in Detroit prioritize in its first 30 days of posting?`
  );

  return prompts;
}

// ─── Call Perplexity API for a single search ──────────────────────────────────
async function searchOne(prompt, searchNumber) {
  const response = await axios.post(
    PERPLEXITY_URL,
    {
      model:      PERPLEXITY_MODEL,
      messages:   [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    },
    {
      headers: {
        Authorization:  `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const text = response.data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Empty response from Perplexity API');

  return { searchNumber, prompt, content: text };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(scrapedVideos, dateString) {
  logger.info('[PerplexityResearch] ─────────────────────────────────────────');
  logger.info('[PerplexityResearch] Starting automated research phase...');

  if (!process.env.PERPLEXITY_API_KEY) {
    logger.warn('[PerplexityResearch] PERPLEXITY_API_KEY not set — skipping research.');
    return null;
  }

  if (!scrapedVideos || scrapedVideos.length === 0) {
    logger.warn('[PerplexityResearch] No scraped videos to extract signals from — skipping.');
    return null;
  }

  const signals = extractSignals(scrapedVideos);
  logger.info(`[PerplexityResearch] Signals extracted from ${signals.topVideosCount} top videos`);
  logger.info(`[PerplexityResearch]   Hashtags: ${signals.topHashtags.slice(0, 4).map((t) => '#' + t).join('  ')}`);
  logger.info(`[PerplexityResearch]   Audio:    ${signals.topAudios.slice(0, 3).join(' | ') || 'none trending'}`);
  logger.info(`[PerplexityResearch]   Accounts: ${signals.topAccounts.map((a) => '@' + a).join('  ') || 'none'}`);

  const prompts = buildPrompts(signals, dateString);
  logger.info(`[PerplexityResearch] Running ${prompts.length} searches in parallel (model: ${PERPLEXITY_MODEL})...`);

  const results = await Promise.allSettled(
    prompts.map((prompt, i) => searchOne(prompt, i + 1))
  );

  const findings = [];
  let successCount = 0;

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      findings.push(result.value);
      successCount++;
      logger.info(`[PerplexityResearch]   ✓ Search ${i + 1} — ${result.value.content.length} chars`);
    } else {
      logger.warn(`[PerplexityResearch]   ✗ Search ${i + 1} failed: ${result.reason?.message}`);
    }
  });

  if (findings.length === 0) {
    logger.warn('[PerplexityResearch] All searches failed — continuing without research.');
    logger.info('[PerplexityResearch] ─────────────────────────────────────────');
    return null;
  }

  logger.info(`[PerplexityResearch] ${successCount}/${prompts.length} searches completed.`);
  logger.info('[PerplexityResearch] ─────────────────────────────────────────');

  return {
    sourceDate: dateString,
    findings:   findings.map((f) => ({ searchNumber: f.searchNumber, prompt: f.prompt, content: f.content })),
    summary:    `Perplexity ${PERPLEXITY_MODEL} research (${dateString}) — ${successCount} of ${prompts.length} searches completed.`,
  };
}

module.exports = { run };
