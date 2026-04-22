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

function fuzzyScore(filename, rec) {
  const nameClean = filename
    .toLowerCase()
    .replace(/\.[^.]+$/, '')        // remove extension
    .replace(/[-_]/g, ' ')          // dashes/underscores to spaces
    .split(' ')
    .filter(Boolean);

  // Build keyword pool from recommendation
  const keywords = [
    ...(rec.title || '').toLowerCase().split(/\s+/),
    ...(rec.contentBrief?.hook || '').toLowerCase().split(/\s+/),
    ...(rec.contentBrief?.hashtagSet || []).map(h => h.toLowerCase().replace(/^#/, '')),
    ...(rec.higgsfieldBrief?.sceneDescription || '').toLowerCase().split(/\s+/),
    ...(rec.rawFootageNote || '').toLowerCase().split(/\s+/),
  ].filter(w => w.length > 3); // ignore short words

  // Score = number of filename words that appear in keyword pool
  const matches = nameClean.filter(word =>
    keywords.some(kw => kw.includes(word) || word.includes(kw))
  );

  return matches.length;
}

function matchOne(rec, footageLibrary) {
  if (!footageLibrary.length) {
    return {
      type:            'needs-shoot',
      matchedFiles:    [],
      seedancePrompt:  '',
      shotList:        rec.contentBrief?.scriptOutline || [],
      shootDirections: rec.higgsfieldBrief?.sceneDescription || '',
    };
  }

  // Score every file and pick the best matches
  const scored = footageLibrary
    .map(f => ({ file: f, score: fuzzyScore(f.name, rec) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (best.score >= 1) {
    // Collect all files with the top score
    const topFiles = scored.filter(s => s.score === best.score).map(s => s.file.name);
    const hf = rec.higgsfieldBrief || {};
    const seedancePrompt = [
      hf.sceneDescription,
      hf.styleDirection ? `Style: ${hf.styleDirection}` : '',
      hf.mood           ? `Mood: ${hf.mood}`             : '',
      hf.audioDirection ? `Audio: ${hf.audioDirection}`  : '',
    ].filter(Boolean).join(' ');

    return {
      type:            'seedance-ready',
      matchedFiles:    topFiles,
      seedancePrompt:  seedancePrompt || rec.trendSummary || '',
      shotList:        [],
      shootDirections: '',
    };
  }

  return {
    type:            'needs-shoot',
    matchedFiles:    [],
    seedancePrompt:  '',
    shotList:        rec.contentBrief?.scriptOutline || [],
    shootDirections: rec.higgsfieldBrief?.sceneDescription || '',
  };
}

async function run(recommendations, footageLibrary) {
  if (!recommendations?.length) return [];

  logger.info(`[FootageMatcher] Matching footage for ${recommendations.length} recommendation(s)...`);
  logger.info(`[FootageMatcher] Footage library: ${footageLibrary.length} file(s) available.`);

  const enriched = [];

  for (const rec of recommendations) {
    try {
      const match       = matchOne(rec, footageLibrary);
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
