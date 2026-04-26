require('dotenv').config();

const Anthropic      = require('@anthropic-ai/sdk');
const path           = require('path');
const fse            = require('fs-extra');
const logger         = require('./logger');
const seriesManager  = require('./seriesManager');
const { DATA_DIR }   = require('./config');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ─── Build prompt for next episode generation ─────────────────────────────────
function buildPrompt(series, trendAnalysis) {
  const scoredEps   = series.episodes.filter(e => e.performanceScore !== null);

  const avgPerf = scoredEps.length
    ? scoredEps.reduce((s, e) => s + e.performanceScore, 0) / scoredEps.length
    : null;

  const episodeHistory = series.episodes.map((e, i) =>
    `Episode ${i + 1}: "${e.title}" — ${e.approved ? `APPROVED (note: ${e.note || 'none'})` : e.rejected ? `REJECTED (note: ${e.note || 'none'})` : 'PENDING'}${e.performanceScore !== null ? ` — Performance score: ${e.performanceScore}` : ''}`
  ).join('\n');

  const trendContext = trendAnalysis ? `
WHAT IS TRENDING RIGHT NOW (apply these signals creatively to this series):
- Top formats: ${(trendAnalysis.topFormats || []).slice(0, 3).join(', ') || 'none'}
- Top keywords: ${(trendAnalysis.topKeywords || []).slice(0, 5).join(', ') || 'none'}
- Top sounds: ${(trendAnalysis.topSounds || []).slice(0, 3).join(', ') || 'none'}
- Performance summary: ${trendAnalysis.performanceSummary || 'none'}
- Confirmed trends: ${(trendAnalysis.confirmedTrends || []).slice(0, 3).map(t => `"${t.title}" — ${t.summary}`).join(' | ') || 'none'}

Your job is to take these trending signals and apply them creatively to the series concept above. If quick cuts and sharp editing are trending, the next episode should use quick cuts and sharp editing applied to this series' subject matter. If POV angles are trending, find a way to use POV within this series concept.` : '';

  const seriesContext = series.type === 'custom'
    ? `SERIES TYPE: Custom (created directly by Chase)
SERIES NAME: "${series.name}"
SERIES DESCRIPTION: ${series.customDescription}

This series was personally designed by the owner. Your job is to generate the next episode by taking what is trending on social media RIGHT NOW and applying it creatively to this series concept. The episode must stay true to the series description while using the most effective current content formats and trends to make it perform.`
    : `SERIES TYPE: Auto (seeded from a recommendation)
SERIES NAME: "${series.name}"
Seed concept: "${series.seedTitle}"
Started: ${series.seedDate}`;

  return `You are generating the next episode recommendation for an ongoing content series for @eatrollin, a premium Asian fusion ghost kitchen in Detroit.

${seriesContext}

EPISODE HISTORY:
${episodeHistory || 'No episodes yet — this is the first episode.'}

${avgPerf !== null ? `Average performance score: ${avgPerf.toFixed(4)}` : 'No performance data yet.'}
${trendContext}

Generate the next episode recommendation. It must:
1. Stay true to the series concept and description
2. Apply current trending formats, editing styles, sounds, and behaviors to the series subject
3. Learn from approvals (do more of what worked) and rejections (avoid what didn't)
4. Be immediately production-ready for @eatrollin
5. Follow Rollin's brand voice: dark, clean, cinematic, bold, chef-driven

Return a single JSON object with this exact schema (no markdown, no wrapper):
{
  "title": "episode title",
  "trendSummary": "which specific trend is being applied and why it works for this series",
  "confidenceScore": 8,
  "label": "AI-FLAGGED",
  "whyItWillWork": "specific reasoning tying the trend signal to the series concept",
  "contentBrief": {
    "hook": "first 3 seconds of the video",
    "scriptOutline": ["beat 1", "beat 2", "beat 3"],
    "captionDirection": "tone and style for caption",
    "sampleCaption": "ready-to-post caption",
    "hashtagSet": ["tag1", "tag2", "tag3"],
    "callToAction": "what to ask viewers"
  },
  "higgsfieldBrief": {
    "sceneDescription": "visual scene for AI video generation",
    "styleDirection": "cinematic style",
    "mood": "dark",
    "durationSeconds": 15,
    "audioDirection": "audio style"
  },
  "rawFootageNote": "what existing footage to use if available"
}`;
}

// ─── Parse Claude response ────────────────────────────────────────────────────
function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text.trim();
  return JSON.parse(candidate);
}

// ─── How many episodes to generate for a series ──────────────────────────────
function episodeCount(series) {
  const scored = series.episodes.filter(e => e.performanceScore !== null);
  if (!scored.length) return 1;
  const avg = scored.reduce((s, e) => s + e.performanceScore, 0) / scored.length;
  return avg > 0.1 ? 2 : 1;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(date, trendAnalysis = null) {
  logger.info('[SeriesEngine] ─────────────────────────────────────────────');
  logger.info('[SeriesEngine] Generating next episodes for active series');
  logger.info('[SeriesEngine] ─────────────────────────────────────────────');

  const activeSeries = await seriesManager.getActiveSeries();

  if (!activeSeries.length) {
    logger.info('[SeriesEngine] No active series — skipping.');
    return [];
  }

  logger.info(`[SeriesEngine] ${activeSeries.length} active series found`);

  const allEpisodes = [];

  for (const series of activeSeries) {
    const count = episodeCount(series);
    logger.info(`[SeriesEngine] Series "${series.name}" — generating ${count} episode(s)`);

    for (let i = 0; i < count; i++) {
      try {
        const prompt = buildPrompt(series, trendAnalysis);

        const response = await getClient().messages.create({
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          messages:   [{ role: 'user', content: prompt }],
        });

        const rawText = response.content?.[0]?.text || '';
        let parsed;
        try {
          parsed = extractJSON(rawText);
        } catch (parseErr) {
          logger.error(`[SeriesEngine] Failed to parse episode JSON for series ${series.id}: ${parseErr.message}`);
          continue;
        }

        const epRec = {
          ...parsed,
          id:          `series_ep_${series.id}_${Date.now()}`,
          date:        date || new Date().toISOString().slice(0, 10),
          tier:        parsed.confidenceScore >= 8 ? 'high' : parsed.confidenceScore >= 6 ? 'medium' : 'low',
          seriesId:    series.id,
          seriesName:  series.name,
          episodeNumber: series.episodes.length + 1,
          generatedAt: new Date().toISOString(),
          approved:    false,
          rejected:    false,
        };

        // Save full episode rec to disk so the dashboard can look it up by recId
        const recDir = path.join(DATA_DIR, 'outputs', epRec.date, epRec.tier);
        await fse.ensureDir(recDir);
        await fse.writeJson(path.join(recDir, `${epRec.id}.json`), epRec, { spaces: 2 });
        logger.info(`[SeriesEngine]   ✓ Saved episode rec to outputs/${epRec.date}/${epRec.tier}/${epRec.id}.json`);

        const saved = await seriesManager.addEpisode(series.id, epRec);
        if (saved) {
          allEpisodes.push({ ...epRec, episodeId: saved.id });
          logger.info(`[SeriesEngine]   ✓ Episode ${saved.id} generated: "${epRec.title}"`);
        }

        // Reload series for next iteration so episode count stays accurate
        const refreshed = await seriesManager.getActiveSeries();
        const updated   = refreshed.find(s => s.id === series.id);
        if (updated) Object.assign(series, updated);

      } catch (err) {
        logger.error(`[SeriesEngine]   ✗ Failed for series ${series.id}: ${err.message}`);
      }
    }
  }

  logger.info('[SeriesEngine] ─────────────────────────────────────────────');
  logger.info(`[SeriesEngine] Generated ${allEpisodes.length} episode(s) across ${activeSeries.length} series`);
  logger.info('[SeriesEngine] ─────────────────────────────────────────────');

  return allEpisodes;
}

module.exports = { run };
