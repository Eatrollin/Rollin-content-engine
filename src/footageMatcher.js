require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const fse       = require('fs-extra');
const logger    = require('./logger');

const MODEL = 'claude-sonnet-4-6';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM_PROMPT = `You are a video production coordinator for Rollin, a premium Asian fusion ghost kitchen in Detroit.
Your job: given a content recommendation and a list of available footage files, decide the best production path.

Assess whether the available footage is usable for this specific video idea, then choose ONE outcome:

1. "seedance-ready" — footage exists that fits this concept (images preferred for image-to-video generation)
   - matchedFiles: list of specific filenames to use
   - seedancePrompt: a detailed, cinematic prompt for Seedance AI (describe motion, lighting, mood, subject — 2-4 sentences)

2. "needs-shoot" — no appropriate footage exists
   - shotList: 3-5 specific shots needed (be concrete: angle, subject, action)
   - shootDirections: brief overall direction (1-2 sentences)

Respond ONLY with valid JSON matching this schema exactly:
{
  "type": "seedance-ready" | "needs-shoot",
  "matchedFiles": [],
  "seedancePrompt": "",
  "shotList": [],
  "shootDirections": ""
}`;

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (_) {} }
  try { return JSON.parse(text.trim()); } catch (_) {}
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) { try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {} }
  return null;
}

async function matchOne(rec, footageLibrary) {
  const fileList = footageLibrary.length
    ? footageLibrary.map(f => `${f.name} [${f.folderName}] (${f.isImage ? 'image' : 'video'})`).join('\n')
    : '(no footage available in Drive)';

  const userContent = JSON.stringify({
    recommendation: {
      title:           rec.title,
      contentBrief:    rec.contentBrief,
      higgsfieldBrief: rec.higgsfieldBrief,
      rawFootageNote:  rec.rawFootageNote,
    },
    availableFootage: fileList,
  }, null, 2);

  const message = await getClient().messages.create({
    model:      MODEL,
    max_tokens: 1024,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userContent }],
  });

  const parsed = extractJSON(message.content[0]?.text || '');
  if (!parsed) {
    return { type: 'needs-shoot', matchedFiles: [], seedancePrompt: '', shotList: [], shootDirections: 'Could not parse matching response.' };
  }

  return {
    type:            parsed.type === 'seedance-ready' ? 'seedance-ready' : 'needs-shoot',
    matchedFiles:    Array.isArray(parsed.matchedFiles)    ? parsed.matchedFiles    : [],
    seedancePrompt:  parsed.seedancePrompt  || '',
    shotList:        Array.isArray(parsed.shotList)        ? parsed.shotList        : [],
    shootDirections: parsed.shootDirections || '',
  };
}

async function run(recommendations, footageLibrary) {
  if (!recommendations?.length) return [];
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn('[FootageMatcher] ANTHROPIC_API_KEY not set — skipping matching.');
    return recommendations;
  }

  logger.info(`[FootageMatcher] Matching footage for ${recommendations.length} recommendation(s)...`);
  logger.info(`[FootageMatcher] Footage library: ${footageLibrary.length} file(s) available.`);

  const enriched = [];

  for (const rec of recommendations) {
    try {
      const match       = await matchOne(rec, footageLibrary);
      rec.footageMatch  = match;

      // Persist to JSON file on disk
      if (rec.savedPaths?.json) {
        try {
          const existing       = await fse.readJson(rec.savedPaths.json);
          existing.footageMatch = match;
          await fse.writeJson(rec.savedPaths.json, existing, { spaces: 2 });
        } catch (writeErr) {
          logger.warn(`[FootageMatcher] Could not update disk file for ${rec.id}: ${writeErr.message}`);
        }
      }

      const filesNote = match.matchedFiles.length ? ` (${match.matchedFiles.length} file(s))` : '';
      logger.info(`[FootageMatcher]  ${rec.id} → ${match.type}${filesNote}`);
    } catch (err) {
      logger.error(`[FootageMatcher] Failed for ${rec.id}: ${err.message}`);
      rec.footageMatch = { type: 'needs-shoot', matchedFiles: [], seedancePrompt: '', shotList: [], shootDirections: '' };
    }

    enriched.push(rec);
  }

  const seedanceCount = enriched.filter(r => r.footageMatch?.type === 'seedance-ready').length;
  const shootCount    = enriched.filter(r => r.footageMatch?.type === 'needs-shoot').length;
  logger.info(`[FootageMatcher] Done — ${seedanceCount} seedance-ready, ${shootCount} needs-shoot.`);

  return enriched;
}

module.exports = { run };
