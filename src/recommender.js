require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const fse       = require('fs-extra');
const path      = require('path');
const os        = require('os');
const logger    = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const MODEL              = 'claude-sonnet-4-6';
const MAX_TOKENS         = 32000;
const TOTAL_RECS         = 12;
const BATCH_SIZE         = 6;  // recommendations per Claude call — keeps responses under token cap
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
const SYSTEM_PROMPT = `You are the creative content strategist AND production planner for Rollin, a premium Asian fusion ghost kitchen in Detroit, Michigan.

BRAND CONTEXT:
- Restaurant: Rollin
- Concept: Premium Asian fusion ghost kitchen — delivery-first, no dine-in
- Location: Detroit, Michigan
- Opening: June 1st
- Social handles: @eatrollin on Instagram and TikTok
- Brand voice: Dark, clean, modern, bold, chef-driven. Premium but never stiff or pretentious.
- Aesthetic: Cinematic food photography, dramatic lighting, raw kitchen energy, precise plating
- Audience: Detroit food culture, Asian food enthusiasts, ghost kitchen early adopters

PRODUCTION CONTEXT — CRITICAL:
- All filming is done on iPhone 17 with external microphones
- All editing happens in CapCut (mobile and desktop)
- The team is Chase (creative direction, editor) and Chef Ivan (on-camera talent, kitchen)
- Final video format: 15-45 second vertical reels for Instagram and TikTok
- Average target: 15 clips per finished video
- Every recommendation must be 100% executable using only iPhone 17 + CapCut. Do not suggest gear-dependent techniques like aperture control, prime lenses, or complex DSLR-only setups.

YOUR ROLE:
Turn trend intelligence into 12 specific, production-ready content recommendations for @eatrollin.
Each recommendation must include a complete production package — shoot list, edit timeline, and execution chain — that lets Chase pick up his iPhone, film, and edit in CapCut without any creative decisions left to make.

RECOMMENDATION STANDARDS:
1. Every hook must be written for the first 3 seconds on TikTok/Reels — fast, visual, no wasted frames
2. Script outlines are beat-by-beat, not vague bullet points
3. Captions match Rollin's voice: dark, confident, minimal. No exclamation points. No cringe.
4. Higgsfield briefs must be specific enough to generate a real video — describe lighting, movement, mood, subject
5. Confidence scores reflect realistic potential for @eatrollin specifically — not generic virality

PRODUCTION PACKAGE STANDARDS — CRITICAL:
You must generate two separate ordered lists for every recommendation:

1. SHOOT LIST — the order to physically film clips on shoot day, optimized for kitchen logic and food state.
   Example: A "How we make our pork belly bao" video shows the finished bao first in the edit, but the bao must be FILMED LAST because it has to be hot, fresh, and visually perfect at the moment of capture. Pork belly cooking, bao steaming, and assembly must be filmed in that natural order. Plate the finished bao at the very end of the shoot day so it's at peak visual quality.

2. EDIT ORDER — the order clips appear in the final video, which is almost always different from the shoot order. This is what Chase paste-references while building the CapCut timeline.

Both lists must explicitly reference each other. Every shoot list clip has a number (Clip 1, Clip 2…). Every edit order slot references which Shoot Clip number to use.

Each Shoot Clip must include:
- subject (what is being filmed)
- cameraAngle (overhead, eye-level, low angle, POV, side profile, etc.)
- shotDistance (extreme close-up, close-up, medium, wide)
- cameraMovement (static, slow push-in, slow pan, handheld follow, etc.)
- recordDuration (how long to record — always longer than the final cut)
- lighting (key light direction, ambient, window light, dark backdrop, etc.)
- criticalDetail (the one thing that MUST be visible — steam, sauce drip, char, knife angle)

Each Edit Order slot must include:
- timestamp (e.g. "0:00-0:03")
- shootClipRef (which Shoot Clip number)
- finalDuration (how long this clip is in the final video)
- onScreenText (any burned-in text, or null)
- audioCue (when audio drops, beats, transitions occur, or null)
- transitionIn (cut, fade, whip pan, match cut, etc.)

OUTPUT FORMAT:
Respond ONLY with a valid JSON object. No markdown. No prose. Exactly this schema:

{
  "recommendations": [
    {
      "id": "rec_001",
      "rank": 1,
      "title": "Short memorable recommendation title",
      "sourceTrendId": "trend_001 or ai_001",
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
      "productionPackage": {
        "totalClipsToShoot": 15,
        "estimatedShootTime": "45 minutes",
        "finalVideoDuration": "22 seconds",
        "musicAndAudioPlan": "Specific guidance — what audio to use, where it drops, where it cuts. Match the audio direction from trends.",
        "shootList": [
          {
            "clipNumber": 1,
            "subject": "Pork belly searing in cast iron, fat rendering",
            "cameraAngle": "low angle, side profile",
            "shotDistance": "extreme close-up",
            "cameraMovement": "slow push-in",
            "recordDuration": "10 seconds",
            "lighting": "single warm key light from left, dark backdrop",
            "criticalDetail": "Visible bubbling fat and steam"
          }
        ],
        "editOrder": [
          {
            "slotNumber": 1,
            "timestamp": "0:00-0:02",
            "shootClipRef": "Clip 14",
            "finalDuration": "2 seconds",
            "onScreenText": "Pork belly bao",
            "audioCue": "Audio starts — sub-bass drop on cut",
            "transitionIn": "Hard cut from black"
          }
        ]
      },
      "rawFootageNote": "Specific guidance on what to film or what raw footage to use",
      "higgsfieldBrief": {
        "sceneDescription": "Detailed visual description of the scene",
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

// ─── Load style learning history (Chase's +style / -style feedback) ──────────
async function loadStyleLearning() {
  try {
    const { DATA_DIR } = require('./config');
    const stylePath    = path.join(DATA_DIR, 'style-learning.json');
    if (!(await fse.pathExists(stylePath))) return null;
    const data = await fse.readJson(stylePath);
    const entries = (data.entries || []).slice(-30);
    if (entries.length === 0) return null;

    const liked = entries.filter(e => e.type === 'positive').map(e => ({
      title:  e.recTitle,
      reason: e.reason,
      date:   e.recordedAt,
    }));
    const disliked = entries.filter(e => e.type === 'negative').map(e => ({
      title:  e.recTitle,
      reason: e.reason,
      date:   e.recordedAt,
    }));

    logger.info(`[Recommender] Loaded style learning: ${liked.length} liked, ${disliked.length} disliked`);
    return { liked, disliked };
  } catch (err) {
    logger.warn(`[Recommender] Could not load style learning: ${err.message}`);
    return null;
  }
}

// ─── Load previously recommended titles to prevent duplicates ────────────────
async function loadPreviousTitles(outputsBase) {
  try {
    const outputsDir    = path.dirname(outputsBase);
    const currentFolder = path.basename(outputsBase);
    const allFolders    = await fse.readdir(outputsDir).catch(() => []);

    const pastFolders = allFolders
      .filter(f => /^\d{4}-\d{2}-\d{2}/.test(f) && f !== currentFolder)
      .sort()
      .reverse()
      .slice(0, 10); // look back across last 10 runs

    const titles = [];
    for (const folder of pastFolders) {
      for (const tier of ['high', 'medium', 'low']) {
        const tierDir = path.join(outputsDir, folder, tier);
        if (!(await fse.pathExists(tierDir))) continue;
        const files = (await fse.readdir(tierDir)).filter(f => f.endsWith('.json'));
        for (const f of files) {
          try {
            const data = await fse.readJson(path.join(tierDir, f));
            if (data.title) titles.push({ title: data.title, date: folder });
          } catch { /* skip corrupt file */ }
        }
      }
    }

    logger.info(`[Recommender] Loaded ${titles.length} previously recommended titles from ${pastFolders.length} past runs`);
    return titles;
  } catch (err) {
    logger.warn(`[Recommender] Could not load previous titles: ${err.message}`);
    return [];
  }
}

// ─── Build user prompt ────────────────────────────────────────────────────────
function buildPrompt(trendAnalysis, scoredVideos, previousTitles = [], styleLearning = null, batchInfo = null) {
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
      batchInfo
        ? `Generate exactly ${batchInfo.batchSize} content recommendations (batch ${batchInfo.batchNumber} of ${batchInfo.totalBatches} — ranks ${batchInfo.startRank} through ${batchInfo.endRank} of ${TOTAL_RECS} total).`
        : `Generate exactly ${TOTAL_RECS} content recommendations for @eatrollin.`,
      'CRITICAL: The previouslyRecommended field contains titles already recommended in past runs. You must NOT recommend anything with the same title or the same core concept as any entry in that list. Every recommendation this run must be genuinely new.',
      'Use the confirmed trends as the primary source — derive recommendations directly from what is KPI-proven.',
      'Fill remaining slots with AI-flagged observations if needed.',
      'Rank by confidence score descending (rank 1 = highest confidence).',
      'Confidence scores must reflect realistic potential for @eatrollin — a ghost kitchen with no existing audience launching June 1st in Detroit.',
      'Every recommendation must be specific to Rollin\'s dark, premium, chef-driven brand voice.',
      'Do not recommend anything that requires a dining room, table service, or front-of-house interaction.',
      'Every recommendation MUST include a complete productionPackage with shootList and editOrder arrays. The shootList is the physical filming order; the editOrder is the final video sequence. They are usually different. Each editOrder slot must reference a shootList clipNumber.',
      'When determining shoot order, think like a chef and a director simultaneously: what state must the food be in, what cooks first, what plates last, what steam needs to be visible at the moment of capture. The finished dish is almost always the LAST thing filmed even if it appears first in the edit.',
      'If a styleLearning field is present in the payload, treat it as the highest-priority signal for production package style. Apply the patterns Chase has marked +style and avoid patterns he has marked -style.',
    ],
    confirmedTrends:       trendAnalysis.confirmedTrends       || [],
    aiFlaggedObservations: trendAnalysis.aiFlaggedObservations || [],
    topKeywords:           trendAnalysis.topKeywords           || [],
    topSounds:             trendAnalysis.topSounds             || [],
    topFormats:            trendAnalysis.topFormats            || [],
    performanceSummary:    trendAnalysis.performanceSummary    || '',
    topPerformingVideosToday: topVideos,
    previouslyRecommended: previousTitles.length > 0 ? previousTitles : 'No previous runs yet — this is the first run.',
    batchContext: batchInfo
      ? {
          note:                  `This is batch ${batchInfo.batchNumber} of ${batchInfo.totalBatches} for this run. Generate exactly ${batchInfo.batchSize} recommendations.`,
          recommendationsAlreadyGeneratedThisRun: batchInfo.alreadyGenerated || [],
          instruction:           batchInfo.alreadyGenerated && batchInfo.alreadyGenerated.length > 0
            ? `Do NOT repeat any titles or core concepts from recommendationsAlreadyGeneratedThisRun. This run has already generated those — your job is to create ${batchInfo.batchSize} different recommendations that complement them.`
            : 'This is the first batch — generate the highest-confidence recommendations.',
        }
      : null,
    styleLearning: styleLearning || 'No style feedback yet — establish a strong default style.',
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

  const previousTitles = await loadPreviousTitles(outputsBase);
  const styleLearning  = await loadStyleLearning();

  // ── Run two batches of BATCH_SIZE — total = TOTAL_RECS ──────────────────
  const totalBatches = Math.ceil(TOTAL_RECS / BATCH_SIZE);
  const allRawRecs   = [];

  for (let batchNumber = 1; batchNumber <= totalBatches; batchNumber++) {
    const startRank = (batchNumber - 1) * BATCH_SIZE + 1;
    const endRank   = Math.min(batchNumber * BATCH_SIZE, TOTAL_RECS);
    const batchSize = endRank - startRank + 1;

    const batchInfo = {
      batchNumber,
      totalBatches,
      batchSize,
      startRank,
      endRank,
      alreadyGenerated: allRawRecs.map(r => ({ title: r.title, trendSummary: r.trendSummary })),
    };

    const userPrompt = buildPrompt(trendAnalysis, scoredVideos, previousTitles, styleLearning, batchInfo);
    logger.info(`[Recommender] ── BATCH ${batchNumber}/${totalBatches} — generating ${batchSize} recs (ranks ${startRank}-${endRank}) ──`);
    logger.info(`[Recommender] Prompt size: ~${Math.round(userPrompt.length / 4)} tokens`);

    let rawResponse = '';
    const MAX_RETRIES = 3;
    let attempt       = 0;
    let batchSucceeded = false;

    while (attempt < MAX_RETRIES && !batchSucceeded) {
      attempt++;
      rawResponse = '';
      try {
        logger.info(`[Recommender] Streaming batch ${batchNumber} response from Claude (attempt ${attempt}/${MAX_RETRIES})...`);
        const stream = await getClient().messages.stream({
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system:     SYSTEM_PROMPT,
          messages:   [{ role: 'user', content: userPrompt }],
        });

        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            rawResponse += event.delta.text;
          }
        }

        logger.info(`[Recommender] Batch ${batchNumber} stream complete — ${rawResponse.length} chars`);
        logger.info(`[Recommender] Batch ${batchNumber} last 300 chars: ${rawResponse.slice(-300)}`);
        batchSucceeded = true;
      } catch (err) {
        logger.error(`[Recommender] Batch ${batchNumber} attempt ${attempt} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          const backoff = attempt * 5000; // 5s, 10s
          logger.info(`[Recommender] Retrying batch ${batchNumber} in ${backoff / 1000}s...`);
          await new Promise(r => setTimeout(r, backoff));
        } else {
          logger.error(`[Recommender] Batch ${batchNumber} exhausted all retries — skipping batch.`);
        }
      }
    }

    if (!batchSucceeded) {
      continue; // skip parse + add for this batch, move to next batch
    }

    let parsed;
    try {
      parsed = extractJSON(rawResponse);
      logger.info(`[Recommender] Batch ${batchNumber} JSON parsed successfully — keys: ${Object.keys(parsed).join(', ')}`);
    } catch (err) {
      logger.error(`[Recommender] Batch ${batchNumber} JSON parse FAILED: ${err.message}`);
      logger.error(`[Recommender] Batch ${batchNumber} response started with: ${rawResponse.slice(0, 200)}`);
      logger.error(`[Recommender] Batch ${batchNumber} response ended with: ${rawResponse.slice(-200)}`);
      continue; // skip this batch but try the next one
    }

    const batchRecs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
    if (batchRecs.length === 0) {
      logger.error(`[Recommender] Batch ${batchNumber} returned no recommendations.`);
      continue;
    }

    logger.info(`[Recommender] Batch ${batchNumber} returned ${batchRecs.length} recommendations`);
    allRawRecs.push(...batchRecs);
  }

  const rawRecs = allRawRecs;
  if (rawRecs.length === 0) {
    logger.error('[Recommender] All batches failed — zero recommendations to save.');
    return [];
  }
  logger.info(`[Recommender] ${rawRecs.length} total recommendations received across ${totalBatches} batches`);

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
      footageMatch:    { type: 'pending', matchedFiles: [], seedancePrompt: '', shotList: [], shootDirections: '' },
    }));

  // ── Series potential — formats that work as recurring series ─────────────
  const SERIES_FORMATS = [
    'chef', 'ivan', 'behind', 'process', 'how we', 'making', 'build',
    'vs', 'challenge', 'reaction', 'taste', 'first time', 'blind',
    'day in', 'weekly', 'episode', 'part', 'series', 'vol', 'recap',
    'reveal', 'drop', 'launch', 'countdown',
  ];
  for (const rec of recs) {
    const titleLower = (rec.title || '').toLowerCase();
    const hookLower  = (rec.contentBrief?.hook || '').toLowerCase();
    const combined   = titleLower + ' ' + hookLower;
    rec.seriesPotential = SERIES_FORMATS.some(f => combined.includes(f));
  }

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
  logger.info(`[Recommender] DATA_DIR is: ${require('./config').DATA_DIR}`);
  saved.forEach((r) => {
    logger.info(
      `[Recommender]  #${r.rank} [${r.tier.toUpperCase()}] [${r.label}] "${r.title}" — ${r.confidenceScore}/10`
    );
  });
  logger.info('[Recommender] ─────────────────────────────────────────────');

  return saved;
}

module.exports = { run, getTier, TOTAL_RECS };
