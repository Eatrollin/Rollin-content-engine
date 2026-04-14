require('dotenv').config();

const path = require('path');
const fse = require('fs-extra');

// ─── Verify required env vars on startup ────────────────────────────────────
const REQUIRED_KEYS = [
  'APIFY_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'HIGGSFIELD_API_KEY',
  'EMAIL_USER',
  'EMAIL_PASSWORD',
];

const missing = REQUIRED_KEYS.filter((k) => !process.env[k] || process.env[k].startsWith('PASTE_'));

if (missing.length > 0) {
  console.warn('\n⚠  ROLLIN CONTENT ENGINE — Missing API keys in .env:');
  missing.forEach((k) => console.warn(`   • ${k}`));
  console.warn('\nOpen .env and fill in the missing values, then restart.\n');
  if (missing.length === REQUIRED_KEYS.length) {
    console.error('All keys are missing. Please configure .env before running.');
    process.exit(1);
  }
}

// ─── Ensure data files exist ─────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const PERF_HISTORY = path.join(DATA_DIR, 'performance-history.json');
const APPROVAL_HISTORY = path.join(DATA_DIR, 'approval-history.json');

fse.ensureDirSync(DATA_DIR);
if (!fse.existsSync(PERF_HISTORY)) fse.writeJsonSync(PERF_HISTORY, { posts: [] }, { spaces: 2 });
if (!fse.existsSync(APPROVAL_HISTORY)) fse.writeJsonSync(APPROVAL_HISTORY, { decisions: [] }, { spaces: 2 });

// ─── Startup ─────────────────────────────────────────────────────────────────
const isDev      = process.argv.includes('--dev');
const isTest     = process.argv.includes('--test');
const isForceRun = process.env.FORCE_RUN === 'true';

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║          ROLLIN CONTENT ENGINE  •  v1.0.0                ║');
console.log('║    Premium Asian Fusion Ghost Kitchen  •  Detroit MI      ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// Start the dashboard server
const dashboardServer = require('./src/dashboard/server');
dashboardServer.start();

// Register the daily scheduler
const scheduler = require('./src/scheduler');
scheduler.register();

// Run pipeline immediately in dev mode, test mode, or when FORCE_RUN=true (Railway)
if (isDev || isTest || isForceRun) {
  const mode = isTest ? 'TEST' : (isForceRun ? 'FORCE_RUN' : 'DEV');
  console.log(`[${mode} MODE] Running pipeline immediately...\n`);
  if (isTest) console.log('[TEST MODE] Step 3 (Apify) will be skipped — loading raw-data cache.\n');
  const pipeline = require('./src/pipeline');
  pipeline.run({ testMode: isTest }).catch((err) => {
    console.error(`[${mode} MODE] Pipeline error:`, err.message);
  });
}
