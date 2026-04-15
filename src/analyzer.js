require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const logger    = require('./logger');

// ─── Claude model ─────────────────────────────────────────────────────────────
const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;

// How many top videos (by composite KPI score) to send Claude
const TOP_VIDEOS_LIMIT = 20;

// ─── Anthropic client (lazy init) ─────────────────────────────────────────────
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000 });
  return _client;
}

// ─── SYSTEM PROMPT — Rollin brand context hardcoded ──────────────────────────
const SYSTEM_PROMPT = `You are the content intelligence analyst for Rollin, a premium Asian fusion ghost kitchen based in Detroit, Michigan.

BRAND CONTEXT:
- Restaurant: Rollin
- Concept: Premium Asian fusion ghost kitchen — delivery-first, no dine-in
- Location: Detroit, Michigan
- Opening: June 1st
- Social handles: @eatrollin on both Instagram and TikTok
- Founders: Chef Ivan (fine dining technique, formerly Tigerlily restaurant) + Chase Zaidan
- Brand voice: Dark, clean, modern, bold, confident, chef-driven. Premium but never stiff or pretentious.
- Visual direction: Dark backgrounds, high contrast, sauce drizzles, steam, char, gloss, texture. Think BlazynCoop cinematic food visuals meets CousinVinny family energy.
- Menu anchors: braised pork belly bao, disrupted crispy rice with Mongolian beef and miso chimichurri, yakitori skewers, hand rolls, house-made sauces
- Target customers: Downtown Detroit lunch professionals and younger late-night diners near Wayne State
- Catchphrase: Every speaking video ends with "Keep Rollin."
- Words to NEVER use in any recommendation: cheap, authentic, traditional, fast food

YOUR ROLE:
You analyze scraped social media data to identify what content formats, behaviors, sounds, and storytelling patterns are driving exceptional engagement in the food and restaurant space. Your job is to give Rollin's team a clear picture of what is working RIGHT NOW so they can create content that competes at the highest level.

ANALYSIS PRINCIPLES:
1. Look for BEHAVIORAL patterns — not just keywords. "Restaurants that film their chef doing X with Y audio while Z is happening in the background" is more useful than "the word 'chef' appeared a lot."
2. A CONFIRMED TREND requires the pattern to appear in 1 or more high-performing videos (above the KPI median) within the 24-hour scrape window. Any significant pattern Claude identifies should be flagged as confirmed.
3. Every observation must include WHY it is likely performing well — psychology, platform mechanics, cultural timing, or format novelty.
4. Always connect trends back to how Rollin specifically can execute them — reference the actual menu (pork belly bao, crispy rice, yakitori, hand rolls), the Detroit customer (lunch professionals, late-night Wayne State crowd), and the visual identity (dark backgrounds, steam, char, sauce drizzles). Never suggest anything that uses the words: cheap, authentic, traditional, fast food.
5. Be specific. "Close-up of sauce being poured in slow motion over white rice with dramatic bass-heavy audio" is better than "food looks good."

OUTPUT FORMAT:
Respond ONLY with a valid JSON object. No markdown code blocks. No prose before or after. The JSON must exactly follow this schema:

{
  "confirmedTrends": [
    {
      "id": "trend_001",
      "title": "Short descriptive trend name",
      "label": "KPI-CONFIRMED",
      "summary": "2-3 sentences: what is happening and why it is performing well",
      "evidenceCount": 4,
      "evidenceAccounts": ["@account1", "@account2"],
      "avgKpiScore": 0.0,
      "contentFormat": "Description of the visual/format pattern",
      "spokenPhrases": ["phrase1", "phrase2"],
      "audioPattern": "Description of sound/music trend if relevant",
      "relevanceToRollin": "Specific, actionable note on how Rollin executes this given their brand",
      "confidenceScore": 8
    }
  ],
  "aiFlaggedObservations": [
    {
      "id": "ai_001",
      "title": "Short observation title",
      "label": "AI-FLAGGED",
      "summary": "What the AI noticed and why it may matter",
      "evidenceCount": 1,
      "evidenceAccounts": ["@account1"],
      "relevanceToRollin": "How this might apply to Rollin",
      "confidenceScore": 5
    }
  ],
  "topKeywords": ["word1", "word2"],
  "topSounds": ["sound name 1", "sound name 2"],
  "topFormats": ["format description 1", "format description 2"],
  "topHashtags": ["hashtag1", "hashtag2"],
  "performanceSummary": "One paragraph plain-English overview of today's content landscape — what is dominating, what is emerging, what Rollin should pay attention to most.",
  "analysisTimestamp": "ISO timestamp"
}`;

// ─── Build user prompt from pipeline data ─────────────────────────────────────
function buildUserPrompt(scoredVideos, transcriptions, ownPostPerformance, perplexityFindings = null, trendingSounds = []) {
  const aboveThreshold = scoredVideos.filter((v) => v.kpi?.passedKpiThreshold);
  const belowThreshold = scoredVideos.filter((v) => !v.kpi?.passedKpiThreshold);

  // ── Dataset overview ───────────────────────────────────────────────────────
  const tiktokAbove    = aboveThreshold.filter((v) => v.platform === 'tiktok').length;
  const instagramAbove = aboveThreshold.filter((v) => v.platform === 'instagram').length;

  const trendingAudio = {};
  for (const v of scoredVideos) {
    const name = v.audioName || v.kpi?.audioReuseName || '';
    if (!name) continue;
    const count = v.kpi?.audioReuseCount || 0;
    if (count >= 2) trendingAudio[name] = count;
  }

  // ── Top 20 videos by composite KPI score (slim fields only) ──────────────
  const topVideos = [...scoredVideos]
    .sort((a, b) => (b.kpi?.compositeScore || 0) - (a.kpi?.compositeScore || 0))
    .slice(0, TOP_VIDEOS_LIMIT)
    .map((v) => ({
      accountHandle:     v.accountHandle,
      platform:          v.platform,
      viewCount:         v.viewCount,
      shareCount:        v.shareCount,
      saveCount:         v.saveCount,
      commentCount:      v.commentCount,
      caption:           v.caption ? v.caption.slice(0, 300) : '',
      hashtags:          v.hashtags || [],
      audioName:         v.audioName || '',
      kpi: {
        compositeScore:    v.kpi?.compositeScore,
        kpiSignalsMatched: v.kpi?.kpiSignalsMatched,
      },
    }));

  // ── @eatrollin own performance — use learningContext if available ────────────
  // ownPostPerformance can be either a raw posts array OR the full learningLoop result
  // object { posts, learningContext, dayOverDay }. Handle both shapes.
  const learningLoopResult = (ownPostPerformance && ownPostPerformance.learningContext)
    ? ownPostPerformance
    : null;

  const ownPerformance = learningLoopResult
    ? learningLoopResult.learningContext
    : (ownPostPerformance && Array.isArray(ownPostPerformance) && ownPostPerformance.length > 0)
      ? ownPostPerformance.map((p) => ({
          postId:         p.id,
          platform:       p.platform,
          postedAt:       p.postedAt,
          kpiScore:       p.latestMetrics?.kpiScore || 0,
          wasRecommended: p.wasRecommended,
          wasApproved:    p.wasApproved,
          caption:        p.caption?.slice(0, 150) || '',
        }))
      : null;

  // ── Assemble final prompt ──────────────────────────────────────────────────
  const payload = {
    analysisDate: new Date().toISOString(),
    datasetOverview: {
      totalScraped:        scoredVideos.length,
      aboveKpiThreshold:   aboveThreshold.length,
      belowKpiThreshold:   belowThreshold.length,
      tiktokAboveThreshold:    tiktokAbove,
      instagramAboveThreshold: instagramAbove,
      medianBaseKpiScore:  aboveThreshold[0]?.kpi?.medianBaseKpiScore || 0,
      trendingAudioSounds: trendingAudio,
      trendingSoundsSignal: trendingSounds.length > 0
        ? trendingSounds.map((s) => ({
            audioName:  s.audioName,
            videoCount: s.videoCount,
            trending:   s.trending,
          }))
        : 'No trending sound data available.',
      note: 'Instagram videos always show shareCount=0 and saveCount=0 — platform restriction.',
    },
    highPerformingVideos: topVideos,
    rollinOwnPerformance: ownPerformance || 'No @eatrollin performance data yet — system is pre-launch.',
    perplexityResearch: perplexityFindings
      ? {
          sourceDate: perplexityFindings.sourceDate,
          note: perplexityFindings.summary,
          findings: perplexityFindings.findings.map((f) => ({
            search:  f.searchNumber,
            prompt:  f.prompt,
            content: f.content,
          })),
        }
      : 'No Perplexity research available for this run.',
    instructions: [
      'Analyze the highPerformingVideos for behavioral patterns — actions, formats, visual styles, spoken language, sounds.',
      'A CONFIRMED trend requires the pattern to appear in 1 or more highPerformingVideos — any significant pattern should be confirmed.',
      'Use AI-FLAGGED only for weak or speculative signals you are not confident in.',
      'For every trend, explain specifically WHY it is performing well.',
      'Connect every insight to how @eatrollin (premium Asian fusion ghost kitchen, Detroit) can execute it.',
      'If rollinOwnPerformance data is present, factor it in — what has worked or not worked on @eatrollin in the past?',
      'If perplexityResearch findings are present, treat them as additional validated context — use them to strengthen or challenge trends you identify from the video data.',
      'Respond ONLY with the JSON schema defined in your system prompt. No prose, no markdown.',
    ],
  };

  return JSON.stringify(payload, null, 2);
}

// ─── JSON extraction — handles Claude wrapping in markdown code blocks ────────
function extractJSON(text) {
  // Strip markdown fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1].trim());

  // Try raw parse first
  try {
    return JSON.parse(text.trim());
  } catch (_) {}

  // Find first { to last } as fallback
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {}
  }

  // Response was cut off — walk backwards from the last valid } to find the
  // largest prefix that parses cleanly. Handles token-limit truncation mid-field.
  if (start !== -1) {
    let closePos = text.lastIndexOf('}');
    while (closePos > start) {
      try {
        const candidate = text.slice(start, closePos + 1);
        const parsed = JSON.parse(candidate);
        logger.warn(
          `[Analyzer] Response truncated — parsed partial JSON (${candidate.length} of ${text.length} chars). ` +
          `Some fields may be missing.`
        );
        return parsed;
      } catch (_) {
        closePos = text.lastIndexOf('}', closePos - 1);
      }
    }
  }

  throw new Error('Could not extract JSON from Claude response');
}

// ─── Validate and normalize Claude's response ─────────────────────────────────
function normalizeResponse(raw, scoredVideos) {
  const confirmed = Array.isArray(raw.confirmedTrends) ? raw.confirmedTrends : [];
  const flagged   = Array.isArray(raw.aiFlaggedObservations) ? raw.aiFlaggedObservations : [];

  // Enforce labels
  confirmed.forEach((t) => { t.label = 'KPI-CONFIRMED'; });
  flagged.forEach((t)   => { t.label = 'AI-FLAGGED'; });

  // Add IDs if missing
  confirmed.forEach((t, i) => { if (!t.id) t.id = `trend_${String(i+1).padStart(3,'0')}`; });
  flagged.forEach((t, i)   => { if (!t.id) t.id = `ai_${String(i+1).padStart(3,'0')}`; });

  return {
    confirmedTrends:        confirmed,
    aiFlaggedObservations:  flagged,
    topKeywords:  Array.isArray(raw.topKeywords)  ? raw.topKeywords  : [],
    topSounds:    Array.isArray(raw.topSounds)    ? raw.topSounds    : [],
    topFormats:   Array.isArray(raw.topFormats)   ? raw.topFormats   : [],
    topHashtags:  Array.isArray(raw.topHashtags)  ? raw.topHashtags  : [],
    performanceSummary: raw.performanceSummary || '',
    analysisTimestamp:  new Date().toISOString(),
    meta: {
      totalScraped:   scoredVideos.length,
      aboveThreshold: scoredVideos.filter((v) => v.kpi?.passedKpiThreshold).length,
      model:          MODEL,
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(scoredVideos, transcriptions = {}, ownPostPerformance = [], perplexityFindings = null, trendingSounds = []) {
  logger.info('[Analyzer] ─────────────────────────────────────────────');
  logger.info('[Analyzer] Claude trend analysis starting...');
  logger.info(`[Analyzer] Model: ${MODEL}`);
  logger.info(
    `[Analyzer] Sending ${scoredVideos.filter((v) => v.kpi?.passedKpiThreshold).length} ` +
    `above-threshold videos + ${Object.keys(transcriptions).length} transcriptions`
  );
  if (perplexityFindings) {
    logger.info(`[Analyzer] Perplexity research: ${perplexityFindings.findings.length} findings from ${perplexityFindings.sourceDate}`);
  }
  if (trendingSounds.length > 0) {
    const flagged = trendingSounds.filter((s) => s.trending);
    logger.info(`[Analyzer] Trending sounds: ${trendingSounds.length} tracked, ${flagged.length} flagged (${flagged.map((s) => `"${s.audioName}"`).join(', ') || 'none'})`);
  }
  logger.info('[Analyzer] ─────────────────────────────────────────────');

  if (!scoredVideos || scoredVideos.length === 0) {
    logger.warn('[Analyzer] No scored videos — skipping analysis.');
    return normalizeResponse({}, []);
  }

  const userPrompt = buildUserPrompt(scoredVideos, transcriptions, ownPostPerformance, perplexityFindings, trendingSounds);
  const promptTokenEstimate = Math.round(userPrompt.length / 4);
  logger.info(`[Analyzer] Prompt size: ~${promptTokenEstimate} tokens`);

  let rawResponse;
  try {
    const message = await getClient().messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    rawResponse = message.content[0]?.text || '';
    logger.info(`[Analyzer] Response received — ${rawResponse.length} chars`);
    logger.info('[Analyzer] ── RAW CLAUDE RESPONSE ──────────────────────');
    logger.info(rawResponse);
    logger.info('[Analyzer] ── END RAW RESPONSE ─────────────────────────');
  } catch (err) {
    logger.error(`[Analyzer] Claude API call failed: ${err.message}`);
    throw err;
  }

  // ── Parse response ────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = extractJSON(rawResponse);
    logger.info('[Analyzer] JSON parsed successfully.');
  } catch (err) {
    logger.error(`[Analyzer] JSON parse failed: ${err.message}`);
    logger.error('[Analyzer] Raw response (first 500 chars):', rawResponse.slice(0, 500));
    throw new Error(`Claude returned unparseable response: ${err.message}`);
  }

  const result = normalizeResponse(parsed, scoredVideos);

  // ── Summary log ───────────────────────────────────────────────────────────
  logger.info('[Analyzer] ─────────────────────────────────────────────');
  logger.info(`[Analyzer] Confirmed trends:       ${result.confirmedTrends.length}`);
  logger.info(`[Analyzer] AI-flagged observations: ${result.aiFlaggedObservations.length}`);
  logger.info(`[Analyzer] Top keywords:            ${result.topKeywords.slice(0,5).join(', ')}`);
  logger.info(`[Analyzer] Top sounds:              ${result.topSounds.slice(0,3).join(', ')}`);

  result.confirmedTrends.forEach((t) => {
    logger.info(
      `[Analyzer] [KPI-CONFIRMED] "${t.title}" — ` +
      `${t.evidenceCount} videos, confidence ${t.confidenceScore}/10`
    );
  });
  result.aiFlaggedObservations.forEach((t) => {
    logger.info(
      `[Analyzer] [AI-FLAGGED]    "${t.title}" — confidence ${t.confidenceScore}/10`
    );
  });

  logger.info('[Analyzer] Analysis complete.');
  logger.info('[Analyzer] ─────────────────────────────────────────────');

  return result;
}

module.exports = { run };
