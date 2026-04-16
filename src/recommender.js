require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const fse       = require('fs-extra');
const path      = require('path');
const logger    = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const MODEL              = 'claude-sonnet-4-6';
const MAX_TOKENS         = 16000;
const TOTAL_RECS         = 12;
const CONTENT_LIB_PATH   = process.env.CONTENT_LIBRARY_PATH ||
                            path.join(os.homedir(), 'Desktop', 'rollin-content');

// Tier thresholds — scores bucket naturally, no forced split
const TIER_HIGH   = 8;   // confidence 8–10 → High
const TIER_MEDIUM = 6;   // confidence 6–7  → Medium
                         // confidence ≤5   → Low

// Supported raw footage extensions to scan from Desktop/rollin-content
const FOOTAGE_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.jpg', '.jpeg', '.png'];

// ─── Anthropic client (lazy init) ─────────────────────────────────────────────
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the creative content strategist for Rollin, a premium Asian fusion ghost kitchen in Detroit, Michigan.

BRAND CONTEXT:
- Restaurant: Rollin
- Concept: Premium Asian fusion ghost kitchen — delivery-first, no dine-in
- Location: Detroit, Michigan
- Opening: June 1st
- Social handles: @eatrollin on Instagram and TikTok
- Brand voice: Dark, clean, modern, bold, chef-driven. Premium but never stiff or pretentious.
- Aesthetic: Cinematic food photography, dramatic lighting, raw kitchen energy, precise plating
- Audience: Detroit food culture, Asian food enthusiasts, ghost kitchen early adopters

YOUR ROLE:
Turn trend intelligence into 12 specific, production-ready content recommendations for @eatrollin.
Each recommendation must be immediately actionable — the team should be able to pick it up and shoot it today.

RECOMMENDATION STANDARDS:
1. Every hook must be written for the first 3 seconds on TikTok/Reels — fast, visual, no wasted frames
2. Script outlines are beat-by-beat, not vague bullet points
3. Captions match Rollin's voice: dark, confident, minimal. No exclamation points. No cringe.
4. Higgsfield briefs must be specific enough to generate a real video — describe lighting, movement, mood, subject
5. Confidence scores reflect realistic potential for @eatrollin specifically — not generic virality

OUTPUT FORMAT:
Respond ONLY with a valid JSON object. No markdown. No prose. Exactly this schema:

{
  "recommendations": [
    {
      "id": "rec_001",
      "rank": 1,
      "title": "Short memorable recommendation title",
      "sourceTrendId": "trend_001 or ai_001 — which trend this comes from",
      "label": "KPI-CONFIRMED or AI-FLAGGED",
      "confidenceScore": 9,
      "trendSummary": "2 sentences: what is performing in the market right now and why",
      "contentBrief": {
        "hook": "Exact opening line or visual action for the first 3 seconds",
        "scriptOutline": [
          "0-3s: [opening action/visual]",
          "3-8s: [transition or reveal]",
          "8-15s: [main content beat]",
          "15-25s: [payoff or close]"
        ],
        "captionDirection": "Specific tone, length, and key phrases. Write a sample caption.",
        "sampleCaption": "An actual example caption in Rollin's voice",
        "hashtagSet": ["hashtag1", "hashtag2"],
        "callToAction": "What should viewers do or feel after watching"
      },
      "rawFootageNote": "Specific guidance on what to film or what raw footage to use",
      "higgsfieldBrief": {
        "sceneDescription": "Detailed visual description of the scene — subject, action, environment",
        "styleDirection": "Lighting style, color grade, camera movement, lens feel",
        "mood": "One word mood descriptor",
        "durationSeconds": 15,
        "audioDirection": "Sound design or music style guidance"
      },
      "whyItWillWork": "One sentence on why this specifically works for Rollin in Detroit right now"
    }
  ]
}`;

// ─── Scan raw footage library for matching files ──────────────────────────────
async function scanFootageLibrary(keywords) {
  try {
    const exists = await fse.pathExists(CONTENT_LIB_PATH);
    if (!exists) {
      return { found: false, files: [], note: `Content library not found at ${CONTENT_LIB_PATH}` };
    }

    const allFiles = await fse.readdir(CONTENT_LIB_PATH);
    const mediaFiles = allFiles.filter((f) =>
      FOOTAGE_EXTENSIONS.includes(path.extname(f).toLowerCase())
    );

    if (mediaFiles.length === 0) {
      return { found: false, files: [], note: 'Content library exists but contains no media files yet.' };
    }

    // Match files against recommendation keywords
    const kwLower = keywords.map((k) => k.toLowerCase());
    const matched = mediaFiles.filter((f) => {
      const nameLower = f.toLowerCase();
      return kwLower.some((k) => nameLower.includes(k));
    });

    return {
      found: matched.length > 0,
      files: matched.length > 0 ? matched : mediaFiles.slice(0, 5), // fallback: show first 5
      totalInLibrary: mediaFiles.length,
      note: matched.length > 0
        ? `${matched.length} matching file(s) found in Desktop/rollin-content`
        : `No direct keyword match — ${mediaFiles.length} total files in library`,
    };
  } catch (err) {
    return { found: false, files: [], note: `Could not scan content library: ${err.message}` };
  }
}

// ─── Build user prompt ────────────────────────────────────────────────────────
function buildPrompt(trendAnalysis, scoredVideos) {
  const topVideos = (scoredVideos || [])
    .filter((v) => v.kpi?.passedKpiThreshold)
    .slice(0, 20)
    .map((v) => ({
      account:        `@${v.accountHandle}`,
      platform:       v.platform,
      views:          v.viewCount,
      compositeScore: v.kpi?.compositeScore,
      hashtags:       v.hashtags,
      audio:          v.audioName,
      caption:        v.caption?.slice(0, 200),
    }));

  const payload = {
    instructions: [
      `Generate exactly ${TOTAL_RECS} content recommendations for @eatrollin.`,
      'Use the confirmed trends as the primary source — derive recommendations directly from what is KPI-proven.',
      'Fill remaining slots with AI-flagged observations if needed.',
      'Rank by confidence score descending (rank 1 = highest confidence).',
      'Confidence scores must reflect realistic potential for @eatrollin — a ghost kitchen with no existing audience launching June 1st in Detroit.',
      'Every recommendation must be specific to Rollin\'s dark, premium, chef-driven brand voice.',
      'Do not recommend anything that requires a dining room, table service, or front-of-house interaction.',
    ],
    confirmedTrends:       trendAnalysis.confirmedTrends       || [],
    aiFlaggedObservations: trendAnalysis.aiFlaggedObservations || [],
    topKeywords:           trendAnalysis.topKeywords           || [],
    topSounds:             trendAnalysis.topSounds             || [],
    topFormats:            trendAnalysis.topFormats            || [],
    performanceSummary:    trendAnalysis.performanceSummary    || '',
    topPerformingVideosToday: topVideos,
  };

  return JSON.stringify(payload, null, 2);
}

// ─── Extract JSON from Claude response ───────────────────────────────────────
function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1].trim());

  try { return JSON.parse(text.trim()); } catch (_) {}

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
          `[Recommender] Response truncated — parsed partial JSON (${candidate.length} of ${text.length} chars). ` +
          `Some recommendations may be missing.`
        );
        return parsed;
      } catch (_) {
        closePos = text.lastIndexOf('}', closePos - 1);
      }
    }
  }

  throw new Error('Could not extract JSON from Claude response');
}

// ─── Assign tier based on confidence score ────────────────────────────────────
function getTier(confidenceScore) {
  if (confidenceScore >= TIER_HIGH)   return 'high';
  if (confidenceScore >= TIER_MEDIUM) return 'medium';
  return 'low';
}

// ─── Format recommendation as readable text ───────────────────────────────────
function formatAsText(rec, footage) {
  const br = '─'.repeat(60);
  const lines = [
    br,
    `RECOMMENDATION #${rec.rank} — ${rec.title.toUpperCase()}`,
    `Tier: ${rec.tier.toUpperCase()}  |  Confidence: ${rec.confidenceScore}/10  |  ${rec.label}`,
    br,
    '',
    '[ TREND SUMMARY ]',
    rec.trendSummary,
    '',
    '[ CONTENT BRIEF ]',
    `HOOK: ${rec.contentBrief?.hook || ''}`,
    '',
    'SCRIPT OUTLINE:',
    ...(rec.contentBrief?.scriptOutline || []).map((b) => `  ${b}`),
    '',
    `CAPTION DIRECTION: ${rec.contentBrief?.captionDirection || ''}`,
    '',
    `SAMPLE CAPTION:`,
    `"${rec.contentBrief?.sampleCaption || ''}"`,
    '',
    `HASHTAGS: ${(rec.contentBrief?.hashtagSet || []).map((h) => '#' + h).join(' ')}`,
    '',
    `CALL TO ACTION: ${rec.contentBrief?.callToAction || ''}`,
    '',
    '[ RAW FOOTAGE ]',
    rec.rawFootageNote || 'No specific footage note.',
    footage.note || '',
    footage.files?.length > 0
      ? `Matching files: ${footage.files.join(', ')}`
      : '',
    '',
    '[ HIGGSFIELD VIDEO BRIEF ]',
    `Scene: ${rec.higgsfieldBrief?.sceneDescription || ''}`,
    `Style: ${rec.higgsfieldBrief?.styleDirection || ''}`,
    `Mood: ${rec.higgsfieldBrief?.mood || ''}`,
    `Duration: ${rec.higgsfieldBrief?.durationSeconds || 15}s`,
    `Audio: ${rec.higgsfieldBrief?.audioDirection || ''}`,
    '',
    '[ WHY IT WILL WORK ]',
    rec.whyItWillWork || '',
    '',
    br,
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}

// ─── Save recommendation to disk ─────────────────────────────────────────────
async function saveRecommendation(rec, outputsBase, footage) {
  const tier      = rec.tier;
  const tierDir   = path.join(outputsBase, tier);
  const slug      = `rec_${String(rec.rank).padStart(2, '0')}_${rec.title
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;

  await fse.ensureDir(tierDir);

  // JSON file
  const jsonPath = path.join(tierDir, `${slug}.json`);
  await fse.writeJson(jsonPath, { ...rec, footage }, { spaces: 2 });

  // Human-readable text file
  const txtPath = path.join(tierDir, `${slug}.txt`);
  await fse.writeFile(txtPath, formatAsText(rec, footage), 'utf8');

  logger.info(`[Recommender] Saved [${tier.toUpperCase()}] #${rec.rank}: ${slug}`);
  return { jsonPath, txtPath };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(trendAnalysis, scoredVideos, dateString, outputsBase) {
  logger.info('[Recommender] ─────────────────────────────────────────────');
  logger.info('[Recommender] Generating content recommendations...');
  logger.info(`[Recommender] Model: ${MODEL}  |  Target: ${TOTAL_RECS} recommendations`);
  logger.info(`[Recommender] Confirmed trends available: ${trendAnalysis?.confirmedTrends?.length ?? 0}`);
  logger.info(`[Recommender] AI-flagged observations: ${trendAnalysis?.aiFlaggedObservations?.length ?? 0}`);
  logger.info('[Recommender] ─────────────────────────────────────────────');

  if (!trendAnalysis || (
    !trendAnalysis.confirmedTrends?.length &&
    !trendAnalysis.aiFlaggedObservations?.length
  )) {
    logger.warn('[Recommender] No trend analysis data — cannot generate recommendations.');
    return [];
  }

  // ── Call Claude ───────────────────────────────────────────────────────────
  const userPrompt = buildPrompt(trendAnalysis, scoredVideos);
  logger.info(`[Recommender] Prompt size: ~${Math.round(userPrompt.length / 4)} tokens`);

  let rawResponse;
  try {
    const message = await getClient().messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    });
    rawResponse = message.content[0]?.text || '';
    logger.info(`[Recommender] Claude response: ${rawResponse.length} chars`);
    logger.info('[Recommender] ── RAW CLAUDE RESPONSE ─────────────────────');
    logger.info(rawResponse);
    logger.info('[Recommender] ── END RAW RESPONSE ──────────────────────────');
  } catch (err) {
    logger.error(`[Recommender] Claude API call failed: ${err.message}`);
    throw err;
  }

  // ── Parse response ────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = extractJSON(rawResponse);
    logger.info('[Recommender] JSON parsed successfully.');
  } catch (err) {
    logger.error(`[Recommender] JSON parse failed: ${err.message}`);
    throw new Error(`Recommender got unparseable Claude response: ${err.message}`);
  }

  const rawRecs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  if (rawRecs.length === 0) {
    logger.error('[Recommender] Claude returned no recommendations.');
    logger.error('[Recommender] Parsed object keys:', Object.keys(parsed).join(', ') || '(empty)');
    return [];
  }

  logger.info(`[Recommender] ${rawRecs.length} raw recommendations received from Claude`);

  // ── Normalize, rank, tier ─────────────────────────────────────────────────
  const recs = rawRecs
    .slice(0, TOTAL_RECS)
    .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0))
    .map((rec, i) => ({
      ...rec,
      id:              rec.id || `rec_${String(i + 1).padStart(3, '0')}`,
      rank:            i + 1,
      tier:            getTier(rec.confidenceScore || 5),
      label:           rec.label === 'AI-FLAGGED' ? 'AI-FLAGGED' : 'KPI-CONFIRMED',
      confidenceScore: Number(rec.confidenceScore) || 5,
      generatedAt:     new Date().toISOString(),
      date:            dateString,
      approved:        false,
      rejected:        false,
    }));

  // ── Count by tier ─────────────────────────────────────────────────────────
  const highCount   = recs.filter((r) => r.tier === 'high').length;
  const mediumCount = recs.filter((r) => r.tier === 'medium').length;
  const lowCount    = recs.filter((r) => r.tier === 'low').length;

  logger.info(`[Recommender] Tier split — High: ${highCount}, Medium: ${mediumCount}, Low: ${lowCount}`);

  // ── Scan footage library + save each recommendation ───────────────────────
  const saved = [];

  for (const rec of recs) {
    // Extract keywords from the recommendation for footage matching
    const keywords = [
      ...(rec.contentBrief?.hashtagSet || []),
      ...(rec.title || '').toLowerCase().split(/\s+/),
    ].filter(Boolean);

    const footage = await scanFootageLibrary(keywords);

    // Attach footage info to rec
    rec.footage = footage;

    // Save to disk
    const { jsonPath, txtPath } = await saveRecommendation(rec, outputsBase, footage);
    rec.savedPaths = { json: jsonPath, txt: txtPath };

    saved.push(rec);
  }

  // ── Summary log ───────────────────────────────────────────────────────────
  logger.info('[Recommender] ─────────────────────────────────────────────');
  logger.info(`[Recommender] ${saved.length} recommendations saved to ${outputsBase}`);
  saved.forEach((r) => {
    logger.info(
      `[Recommender]  #${r.rank} [${r.tier.toUpperCase()}] [${r.label}] "${r.title}" — ${r.confidenceScore}/10`
    );
  });
  logger.info('[Recommender] ─────────────────────────────────────────────');

  return saved;
}

module.exports = { run, getTier, TOTAL_RECS };
