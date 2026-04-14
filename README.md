# Rollin Content Engine

Automated daily content intelligence system for **Rollin** — Premium Asian Fusion Ghost Kitchen, Detroit MI.

Every morning at 6am this system scrapes social media, scores the content, analyzes it with AI, generates 12 content recommendations, submits the top 2 to Higgsfield for video generation, and delivers everything to a web dashboard and daily email.

---

## How to Start the System

```bash
# 1. Install dependencies (one time only)
cd Desktop/rollin-content-engine
npm install

# 2. Fill in your API keys in the .env file
# (See "API Keys" section below)

# 3. Start the engine
npm start
```

The system will:
- Start the web dashboard at http://localhost:3000
- Schedule the daily pipeline to run at 6am
- Run the pipeline immediately if you pass the --dev flag: `node index.js --dev`

---

## What Each File Does

### Root
| File | What it does |
|------|-------------|
| `index.js` | Entry point. Starts the dashboard server and registers the daily cron job. |
| `.env` | All API keys and configuration. Never touch the source code for config changes — do it here. |
| `package.json` | Node.js project manifest and dependency list. |

### src/
| File | What it does |
|------|-------------|
| `pipeline.js` | Orchestrates the full daily run. Calls each module in sequence and handles top-level errors. |
| `scheduler.js` | Registers the 6am cron job using node-cron. The schedule is read from `.env` — change `CRON_SCHEDULE` to adjust. |
| `scraper.js` | Hits the Apify API to scrape TikTok and Instagram in parallel. Saves raw data to `raw-data/YYYY-MM-DD.json`. |
| `kpiScorer.js` | Calculates composite KPI scores for every video. Base formula: share rate (50%) + save rate (30%) + comment rate (20%). Also generates dynamic signals. |
| `transcriber.js` | Sends above-median videos to OpenAI Whisper. Stores transcription text alongside video metadata. |
| `analyzer.js` | Sends everything to Claude claude-sonnet-4-6 with Rollin's brand context. Returns confirmed trends and AI-flagged observations. |
| `recommender.js` | Converts Claude's analysis into exactly 12 content recommendations with full briefs, Higgsfield prompts, and confidence scores. |
| `higgsfield.js` | Submits the top 2 High impact recommendations to Higgsfield Cloud API for video generation. |
| `learningLoop.js` | Scrapes @eatrollin on both platforms. Evaluates posts at 24h and 72h checkpoints. Feeds performance history back into analysis. |
| `approvalManager.js` | Handles approve/reject logic from the dashboard. Writes to `data/approval-history.json`. |
| `emailer.js` | Sends the daily HTML brief to chasezaidan@eatrollin.food via Nodemailer. |

### src/dashboard/
| File | What it does |
|------|-------------|
| `server.js` | Express + Socket.io server for the web dashboard. Serves data to the frontend and handles approve/reject API calls. |
| `public/index.html` | Dashboard HTML structure. |
| `public/styles.css` | Dark-themed Rollin brand styles. |
| `public/app.js` | Frontend JavaScript — charts, real-time updates, approve/reject interactions. |

### Data folders
| Folder/File | What it stores |
|------------|----------------|
| `logs/YYYY-MM-DD.log` | Timestamped run logs for each daily pipeline execution. |
| `raw-data/YYYY-MM-DD.json` | All scraped video metadata from each day's run. |
| `data/performance-history.json` | @eatrollin post performance at 24h and 72h checkpoints. |
| `data/approval-history.json` | Every approve and reject decision with timestamps. |
| `Desktop/rollin-outputs/YYYY-MM-DD/high|medium|low/` | The 12 daily recommendations as JSON and text files. |

---

## API Keys

All keys live in `.env` only. Here's where to get each one:

| Key | Where to get it |
|-----|----------------|
| `APIFY_API_KEY` | apify.com → Settings → Integrations → API tokens |
| `ANTHROPIC_API_KEY` | platform.anthropic.com → API Keys |
| `OPENAI_API_KEY` | platform.openai.com → API Keys |
| `HIGGSFIELD_API_KEY` | cloud.higgsfield.ai → Account / API settings |
| `EMAIL_USER` | Your Gmail address you want to send from |
| `EMAIL_PASSWORD` | Gmail App Password — generate at myaccount.google.com/apppasswords (requires 2FA) |

---

## How to Add New Accounts to Track

Open `src/scraper.js` and find the `TRACKED_ACCOUNTS` array near the top. Add the handle without the @:

```js
const TRACKED_ACCOUNTS = [
  'cousinvinnystampa',
  'blazincoop',
  'newaccounthere'   // ← add here
];
```

---

## How to Add New Hashtags to Track

In the same file, find `TRACKED_HASHTAGS`:

```js
const TRACKED_HASHTAGS = [
  'foodtok',
  'asianfoodie',
  'newhashtag'   // ← add here (no # symbol)
];
```

---

## How to Change the Daily Run Time

Open `.env` and edit `CRON_SCHEDULE` using standard cron syntax:

```
CRON_SCHEDULE=0 6 * * *    # 6:00am daily (default)
CRON_SCHEDULE=30 5 * * *   # 5:30am daily
CRON_SCHEDULE=0 7 * * 1-5  # 7:00am weekdays only
```

No code change needed — just save `.env` and restart.

---

## How to Run the Pipeline Manually

```bash
node src/pipeline.js
```

This runs the full pipeline immediately without waiting for the scheduled time. Useful for testing or catching up after a missed run.

---

## How to Upgrade Higgsfield to Full Automation

Currently the system submits the top 2 High impact recommendations automatically. To change the number, open `src/higgsfield.js` and change:

```js
const AUTO_SUBMIT_COUNT = 2; // change to however many you want
```

When Higgsfield releases a polling/webhook endpoint for render completion, update the `checkRenderStatus()` function in the same file to poll the job ID and update the dashboard in real time.

---

## Brand Context (Hardcoded Throughout)

- **Restaurant:** Rollin
- **Concept:** Premium Asian fusion ghost kitchen
- **Location:** Detroit, Michigan
- **Model:** Delivery-first
- **Opens:** June 1st
- **Voice:** Dark, clean, modern, bold, chef-driven, premium but not stiff
- **Handles:** @eatrollin (Instagram + TikTok)
- **Daily email:** chasezaidan@eatrollin.food
- **Raw content library:** Desktop/rollin-content

---

## Troubleshooting

**Pipeline ran but I got no data**
Check `logs/YYYY-MM-DD.log` for the error. Most common cause: Apify API key is wrong or the actor IDs have changed.

**Email not sending**
Make sure `EMAIL_PASSWORD` is a Gmail App Password, not your regular Gmail password. You must have 2FA enabled on the account.

**Dashboard not loading**
Make sure `npm start` is running. Check that port 3000 isn't blocked. Try `http://127.0.0.1:3000` if `localhost:3000` doesn't work.

**Higgsfield submission failing**
Check the `HIGGSFIELD_API_KEY` in `.env`. The module logs all API errors to the daily log file without stopping the pipeline.
