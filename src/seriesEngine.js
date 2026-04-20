require('dotenv').config();

const Anthropic      = require('@anthropic-ai/sdk');
const logger         = require('./logger');
const seriesManager  = require('./seriesManager');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ─── Build prompt for next episode generation ─────────────────────────────────
function buildPrompt(series) {
  const approvedEps = series.episodes.filter(e => e.approved);
  const rejectedEps = series.episodes.filter(e => e.rejected);
  const pendingEps  = series.episodes.filter(e => !e.approved && !e.rejected);
  const scoredEps   = series.episodes.filter(e => e.performanceScore !== null);

  const avgPerf = scoredEps.length
    ? scoredEps.reduce((s, e) => s + e.performanceScore, 0) / scoredEps.length
    : null;

  const episodeHistory = series.episodes.map((e, i) =>
    `Episode ${i + 1}: "${e.title}" — ${e.approved ? `APPROVED (note: ${e.note || 'none'})` : e.rejected ? `REJECTED (note: ${e.note || 'none'})` : 'PENDING'}${e.performanceScore !== null ? ` — Performance score: ${e.performanceScore}` : ''}`
  ).join('\n');

  return `You are generating the next episode recommendation for an ongoing content series for @eatrollin, a premium Asian fusion ghost kitchen in Detroit.

SERIES: "${series.name}"
Seed concept: "${series.seedTitle}"
Started: ${series.seedDate}

EPISODE HISTORY:
${episodeHistory || 'No episodes yet.'}

${avgPerf !== null ? `Average performance score: ${avgPerf.toFixed(4)}` : 'No performance data yet.'}

Generate the next episode recommendation. It must:
1. Continue and evolve the series concept — don't repeat previous episodes
2. Learn from approvals (do more of what worked) and rejections (avoid what didn't)
3. Be immediately production-ready for @eatrollin
4. Follow the same brand voice: dark, clean, cinematic, bold, chef-driven

Return a single JSON object with this exact schema (no markdown, no wrapper):
{
  "title": "episode title",
  "trendSummary": "why this episode works for the series right now",
  "confidenceScore": 8,
  "label": "AI-FLAGGED",
  "whyItWillWork": "specific reasoning tied to series momentum",
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
async function run(date) {
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
        const prompt = buildPrompt(series);

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
