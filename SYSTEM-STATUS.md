# SYSTEM STATUS — Rollin Content Engine

**Last Updated:** 2026-04-13  
**System Version:** 1.0.0  
**Status:** Production-Ready / Pre-Launch (opens June 1, 2026)  
**Operator:** Single user (Chase Zaidan) via web dashboard + daily email  

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [File Structure](#2-file-structure)
3. [Module Reference](#3-module-reference)
4. [Environment Variables](#4-environment-variables)
5. [Known Issues & Fragile Areas](#5-known-issues--fragile-areas)
6. [Tested & Confirmed Working](#6-tested--confirmed-working)
7. [Untested / Not Yet Validated](#7-untested--not-yet-validated)
8. [Key Constants & Hardcoded Values](#8-key-constants--hardcoded-values)
9. [Data Files Reference](#9-data-files-reference)
10. [npm Scripts](#10-npm-scripts)

---

## 1. What This System Does

An automated daily content intelligence pipeline for **Rollin**, a premium Asian fusion ghost kitchen in Detroit, MI. Every morning at 6am (Detroit time) the system:

1. Scrapes TikTok hashtags + Instagram accounts for videos posted in the last 24 hours
2. Scores every video with a composite KPI formula (share/save/comment rates + engagement velocity + audio reuse)
3. Transcribes top-performing videos via OpenAI Whisper
4. Sends the top 20 videos to Claude for behavioral trend analysis
5. Generates 12 ranked content recommendations (with Higgsfield video-gen briefs)
6. Auto-submits the top 2 High-tier recommendations to Higgsfield Cloud for AI video rendering
7. Tracks @eatrollin's own post performance at 24h and 72h checkpoints (learning loop)
8. Serves all results on a local web dashboard (port 3000) with approve/reject controls
9. Sends a daily HTML email brief to chasezaidan@eatrollin.food

---

## 2. File Structure

```
rollin-content-engine/
├── index.js                          Entry point: env validation, startup, scheduler registration
├── package.json                      Dependencies + npm scripts
├── package-lock.json                 Lockfile
├── .env                              API keys and secrets (never commit)
├── .gitignore                        Excludes: .env, logs/, raw-data/, node_modules/
├── README.md                         Setup and operation guide
│
├── src/
│   ├── pipeline.js                   Main orchestrator — runs all pipeline steps in order
│   ├── scheduler.js                  Registers daily node-cron job (default: 6am Detroit)
│   ├── logger.js                     Winston logger with daily file rotation at midnight
│   ├── scraper.js                    Apify TikTok hashtag + Instagram account/hashtag scraper
│   ├── kpiScorer.js                  Composite KPI scoring engine (base + dynamic signals)
│   ├── transcriber.js                OpenAI Whisper speech-to-text for above-threshold videos
│   ├── analyzer.js                   Claude trend analysis (top 20 videos → behavioral patterns)
│   ├── recommender.js                Claude content recommendation generator (exactly 12 recs)
│   ├── higgsfield.js                 Higgsfield Cloud API — submits top 2 High-tier recs
│   ├── learningLoop.js               @eatrollin performance tracking + 24h/72h checkpoints
│   ├── approvalManager.js            Approve/reject logic with 12/day cap enforcement
│   ├── emailer.js                    HTML email brief via Gmail SMTP (Nodemailer)
│   │
│   └── dashboard/
│       ├── server.js                 Express + Socket.io — REST API + real-time events
│       └── public/
│           ├── index.html            Dashboard HTML layout and structure
│           ├── styles.css            Dark-themed Rollin brand CSS (210 lines)
│           └── app.js                Frontend JS — Chart.js, approve/reject, Socket.io (478 lines)
│
├── data/
│   ├── approval-history.json         All approve/reject decisions with timestamps
│   └── performance-history.json      @eatrollin post tracking + 24h/72h checkpoint data
│
├── logs/
│   └── YYYY-MM-DD.log                Daily rotating log files (Winston, Detroit timezone)
│
└── raw-data/
    └── YYYY-MM-DD.json               Raw scrape output — used by pipeline and --test mode
```

**Runtime-generated (not in repo):**
```
OUTPUTS_PATH/                         Default: Desktop/rollin-outputs
└── YYYY-MM-DD/
    ├── high/
    │   ├── rec_01_<slug>.json
    │   └── rec_01_<slug>.txt
    ├── medium/
    │   └── rec_06_<slug>.json / .txt
    └── low/
        └── rec_11_<slug>.json / .txt
```

---

## 3. Module Reference

### `index.js` — Entry Point
Validates all required environment keys at startup, creates data files if missing, starts the dashboard server, registers the scheduler, and optionally runs the pipeline immediately.

- `--dev` flag: runs pipeline immediately after startup
- `--test` flag: skips Apify scraping, loads cached `raw-data/YYYY-MM-DD.json` instead
- Warns on missing env keys but only hard-exits if ALL keys are absent

---

### `src/pipeline.js` — Main Orchestrator
Runs all pipeline steps in sequence. Each step is wrapped individually — a failure is logged but does not stop subsequent steps (with the exception of Claude steps, which throw fatally).

**Step order:**
1. `scraper.run()` → raw videos
2. `kpiScorer.score()` → scored videos
3. `transcriber.run()` → transcriptions map
4. `learningLoop.run()` → @eatrollin context
5. `analyzer.run()` → trend analysis
6. `recommender.run()` → 12 saved recommendations
7. `higgsfield.run()` → Higgsfield job submissions
8. `emailer.send()` → daily email brief
9. `dashboard.emit('pipeline:complete')` → push to UI

---

### `src/scheduler.js` — Cron Scheduler
Registers a single daily `node-cron` job. Timezone hardcoded to `America/Detroit`. Reads schedule from `CRON_SCHEDULE` env var; falls back to `0 6 * * *` (6:00am) if unset or invalid. Invalid expressions are logged as a warning, not a crash.

---

### `src/logger.js` — Winston Logger
Centralized logger used by every module via `require('./logger')`. Writes to both console (colorized) and a date-stamped file in `logs/`. File rotates at midnight Detroit time via a secondary cron (`1 0 * * *`) to ensure log entries land in the correct day's file. All timestamps are Detroit local time.

---

### `src/scraper.js` — Apify Social Media Scraper
Scrapes recent trending content via the Apify API.

**Targets:**
- **TikTok:** 12 hashtags — `foodtok`, `asianfoodie`, `ghostkitchen`, `restaurantlife`, `cheflife`, `foodreels`, `asianfusion`, `detroitfood`, `foodcinema`, `foodie`, `foodcontent`, `detroiteats` (150 items max per hashtag)
- **Instagram:** 2 competitor accounts — `blazincoop`, `cousinvinnyssandwichco` (100 items max per account)
- **Window:** Only videos posted within the last 24 hours are kept
- **Actors:** `clockworks/tiktok-scraper` (TikTok), `apify/instagram-scraper` (Instagram)

**Output:** Saves to `raw-data/YYYY-MM-DD.json`. Normalizes all videos to a common schema. Deduplicates by URL/ID.

**Platform restriction:** Instagram does not expose `shareCount` or `saveCount` — both are hardcoded to `0` in the normalized output. The KPI scorer accounts for this.

**TikTok account scraping was removed** as unreliable — hashtag-only scraping is used.

---

### `src/kpiScorer.js` — KPI Scoring Engine
Calculates a composite performance score for every video. The base formula is **frozen** and must not change without re-approval.

**Base KPI (70% of composite — permanent):**
```
baseKpiScore = (shareRate × 0.50) + (saveRate × 0.30) + (commentRate × 0.20)
```

**Dynamic signals (30% of composite — normalized per day's dataset):**
- Engagement velocity (50% of dynamic): engagement per hour since posting
- Audio reuse (20%): how many videos in today's scrape share the same audio
- Hashtag frequency (20%): average popularity of a video's hashtags in the dataset
- Posting time (10%): correlation with high-engagement posting hours

**KPI threshold:** 40th percentile of base scores — top 60% of each day's dataset passes.

**Key outputs attached to `video.kpi`:** `baseKpiScore`, `compositeScore`, `kpiSignalsMatched[]`, `passedKpiThreshold`, `engagementVelocity`, `audioReuseCount`, `instagramDataLimited`.

---

### `src/transcriber.js` — OpenAI Whisper Transcription
Transcribes speech from above-threshold videos using the `whisper-1` model. Processes sequentially (not in parallel) to respect rate limits and avoid disk bloat. Only videos that `passedKpiThreshold` are transcribed.

- Downloads video to temp file → validates size (24MB max) → sends to Whisper → cleans up
- Aborts after 3 consecutive network errors; pipeline continues without transcripts
- Transcription failures are non-fatal — analyzer falls back to KPI signals only

---

### `src/analyzer.js` — Claude Trend Analysis
Sends the top 20 videos (sorted by `compositeScore` descending) + available transcriptions + @eatrollin learning context to Claude. Returns behavioral trend analysis.

**Model:** `claude-sonnet-4-6` | **Max tokens:** 8192 | **Timeout:** 300 seconds

**Video fields sent to Claude (stripped for prompt size):**
`accountHandle`, `platform`, `viewCount`, `shareCount`, `saveCount`, `commentCount`, `caption` (≤300 chars), `hashtags`, `audioName`, `kpi.compositeScore`, `kpi.kpiSignalsMatched`

**Output schema:** `confirmedTrends[]`, `aiFlaggedObservations[]`, `topKeywords[]`, `topSounds[]`, `topFormats[]`, `topHashtags[]`, `performanceSummary`, `analysisTimestamp`

**Confirmed trend** = pattern found in 1+ high-performing videos. **AI-flagged** = weak or speculative signal. JSON parse or API failure is fatal (throws).

---

### `src/recommender.js` — Content Recommendation Generator
Takes Claude's trend analysis and generates **exactly 12** production-ready content briefs via a second Claude call. Each brief includes a full content strategy + a Higgsfield video-gen prompt. Scans `CONTENT_LIBRARY_PATH` (Desktop/rollin-content) for matching raw footage.

**Model:** `claude-sonnet-4-6` | **Max tokens:** 8192

**Output tiers by confidence score:** High (8–10), Medium (6–7), Low (≤5). Saves each rec as both `.json` (machine-readable) and `.txt` (human-readable) in `OUTPUTS_PATH/YYYY-MM-DD/{tier}/`.

Fewer than 12 recommendations returned by Claude is a fatal error (throws).

---

### `src/higgsfield.js` — Higgsfield Video Generation
Submits the top 2 High-tier recommendations to the Higgsfield Cloud API for AI video rendering. Processes sequentially. If matching footage is found in `CONTENT_LIBRARY_PATH`, it is sent as a multipart form upload; otherwise sends JSON-only (text-to-video mode).

Writes the returned `jobId` and `status` back into the recommendation's `.json` file. Dashboard calls `checkJobStatus(jobId)` manually to poll for render completion — there is currently no automated polling or webhook.

If no High-tier recommendations exist, this step is silently skipped.

---

### `src/learningLoop.js` — @eatrollin Performance Tracking
Scrapes `@eatrollin`'s own TikTok and Instagram posts (up to 30 per platform) and tracks their performance at two checkpoints:

- **24h checkpoint:** recorded when post is between 22–36 hours old
- **72h checkpoint (final):** recorded when post is between 70–120 hours old

Builds a `learningContext` object passed to the analyzer so Claude can factor in what has and hasn't worked for @eatrollin specifically. Also calculates day-over-day KPI trend. Cross-references posts against `approval-history.json` to link performance to decisions.

The learning loop is **optional** — if @eatrollin has no posts yet, the analyzer falls back to "system is pre-launch" and continues normally.

---

### `src/approvalManager.js` — Approve/Reject Logic
Handles the operator's approve/reject decisions from the dashboard. Enforces a hard cap of 12 approvals per day. Writes decisions to `data/approval-history.json` and updates the individual recommendation `.json` file. Broadcasts a `approval:update` Socket.io event so the dashboard updates in real time.

Tracks rejection patterns (title, tier, hashtags, reason) to feed back into the learning loop.

---

### `src/emailer.js` — Daily Email Brief
Generates a dark-themed HTML email and sends it via Gmail SMTP (Nodemailer, port 587). Content includes: scrape stats, @eatrollin day-over-day performance, top 3 trends, top 3 recommendations with 10-dot confidence bars, and a dashboard CTA button.

**Recipient:** `chasezaidan@eatrollin.food` (hardcoded)  
**Requires:** Gmail App Password (2FA must be enabled; regular password will fail)

---

### `src/dashboard/server.js` — Express + Socket.io Backend
Serves the web dashboard on port 3000. Exposes REST endpoints for state, approvals, and Higgsfield status. Emits real-time Socket.io events to connected clients.

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/state?date=YYYY-MM-DD` | Full dashboard state for a date (defaults to today) |
| `POST` | `/api/approve` | Body: `{ recId, date, tier }` |
| `POST` | `/api/reject` | Body: `{ recId, date, tier, note }` |
| `GET` | `/api/higgsfield/:jobId` | Poll Higgsfield job status |

**Socket.io events emitted:** `pipeline:complete`, `approval:update`

---

### `src/dashboard/public/` — Frontend Dashboard
- **`index.html`** — Layout: nav, 5 metric cards, 3 Chart.js charts, 12-rec grid, Higgsfield jobs table, @eatrollin performance history table
- **`styles.css`** — Dark theme (`#0a0a0a` background, `#c8a96e` gold accent)
- **`app.js`** — Fetches `/api/state`, renders charts (KPI distribution, tier breakdown, 7-day trend), handles approve/reject button clicks, listens for Socket.io events

---

## 4. Environment Variables

### Required (system will warn/fail without these)

| Variable | Purpose | Where to get it |
|----------|---------|----------------|
| `APIFY_API_KEY` | Apify scraping API token | apify.com → Settings → Integrations → API tokens |
| `ANTHROPIC_API_KEY` | Claude API key (analyzer + recommender) | platform.anthropic.com → API Keys |
| `OPENAI_API_KEY` | OpenAI Whisper transcription | platform.openai.com → API Keys |
| `HIGGSFIELD_API_KEY` | Higgsfield Cloud Bearer token | cloud.higgsfield.ai → Account / API settings |
| `EMAIL_USER` | Gmail address sending the daily brief | Your Gmail address |
| `EMAIL_PASSWORD` | Gmail **App Password** (not account password) | myaccount.google.com/apppasswords (requires 2FA) |

### Optional (have working defaults)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DASHBOARD_PORT` | `3000` | Local web dashboard port |
| `CRON_SCHEDULE` | `0 6 * * *` | Daily pipeline trigger (6am Detroit) |
| `FORCE_RUN` | *(unset)* | Set to `true` to run the pipeline immediately on startup (use in Railway instead of `--dev`) |
| `CONTENT_LIBRARY_PATH` | `Desktop/rollin-content` | Raw footage for Higgsfield submission |
| `OUTPUTS_PATH` | `Desktop/rollin-outputs` | Where recommendation files are saved |

### Which modules use which variable

| Variable | Used by |
|----------|---------|
| `APIFY_API_KEY` | `scraper.js`, `learningLoop.js` |
| `ANTHROPIC_API_KEY` | `analyzer.js`, `recommender.js` |
| `OPENAI_API_KEY` | `transcriber.js` |
| `HIGGSFIELD_API_KEY` | `higgsfield.js` |
| `EMAIL_USER` / `EMAIL_PASSWORD` | `emailer.js` |
| `DASHBOARD_PORT` | `dashboard/server.js`, `emailer.js` |
| `CRON_SCHEDULE` | `scheduler.js` |
| `CONTENT_LIBRARY_PATH` | `recommender.js`, `higgsfield.js` |
| `OUTPUTS_PATH` | `pipeline.js`, `recommender.js`, `approvalManager.js`, `dashboard/server.js` |

---

## 5. Known Issues & Fragile Areas

### Confirmed Issues

**`higgsfield.js` — No automated polling for render status**  
Higgsfield has not released a polling/webhook endpoint. `checkJobStatus()` exists but must be called manually from the dashboard. There is no background job watching for render completion. Once Higgsfield releases webhooks, this function needs to be wired up.

**`dashboard/server.js` — 7-day trending is actually 6 days**  
`loadSevenDayPerf()` looks back 6 days (indices 0–5), not 7. The chart label says "7-day trend" but only covers 6 data points. Off-by-one in the loop.

**`emailer.js` — Helper function reference order**  
`dodColor2()` is referenced in the email HTML template before it is defined in the file. This works due to JavaScript function hoisting but is fragile if the function is ever refactored to an arrow function.

### Fragile Areas (Risk of Silent Failure)

**Apify scraping reliability**  
If both TikTok and Instagram scrapes return empty (timeout, rate limit, actor error), the pipeline runs to completion with zero videos. Claude receives an empty dataset and returns a minimal/generic analysis. No alert is raised. Monitor logs for `[Scraper] Total videos after dedup: 0`.

**Claude JSON parsing**  
Both `analyzer.js` and `recommender.js` parse Claude's response as JSON. If Claude wraps output in markdown fences or returns prose, `extractJSON()` attempts recovery. If that fails, the entire step throws and the day's recommendations are lost. There is no retry and no fallback to a previous day's output.

**Whisper rate limits / network errors**  
If 3 consecutive transcription network errors occur, transcription aborts for the rest of that run. Claude analyzes KPI signals only (no speech content). Non-network errors (no-speech, file too large) do not count toward the consecutive error limit.

**Instagram KPI scoring is degraded by design**  
Instagram never exposes `shareCount` or `saveCount`. These are hardcoded to `0`. The base KPI formula weights shares at 50% and saves at 30% — meaning Instagram videos are structurally disadvantaged in KPI ranking. The scorer marks these as `instagramDataLimited: true`.

**No retry logic on any Claude or Higgsfield API call**  
A single transient API error kills the step. No exponential backoff, no retry. Consider adding retry logic if timeouts become common.

**Content library path is Windows-specific**  
Default `CONTENT_LIBRARY_PATH` and `OUTPUTS_PATH` assume Windows desktop paths. If this ever runs on Linux/macOS, these defaults will resolve incorrectly.

**Approval cap has no rollover**  
Hard cap of 12 approvals/day with no overflow queue. If the operator hits the cap and wants to approve more, they must wait until the next day. There is no "pending" state or next-day carry-forward.

**Learning loop bootstrap period**  
Until @eatrollin has posts with completed 72h checkpoints, the learning context will always return "system is pre-launch." The analyzer prompt notes this, but Claude has no real performance history to learn from for the first ~3 days of operation.

**Timezone hardcoding**  
`America/Detroit` is hardcoded in `logger.js`, `scheduler.js`, `dashboard/server.js`, and `learningLoop.js`. If the server's system timezone differs, log files, cron triggers, and date strings will all be internally consistent but may appear offset in external tools.

---

## 6. Tested & Confirmed Working

The following have been validated through actual runs:

- **Full pipeline end-to-end** — all 9 steps complete, recommendation files are generated, email sends, dashboard updates
- **Apify TikTok hashtag scraping** — returns normalized video objects within the 24h window
- **Apify Instagram account scraping** — returns normalized video objects; `shareCount`/`saveCount` correctly set to `0`
- **KPI scorer** — composite scores calculated, `passedKpiThreshold` boolean correctly applied, audio reuse and velocity signals firing
- **Whisper transcription** — above-threshold videos are downloaded, transcribed, and text returned keyed by video ID
- **Claude analyzer** — returns valid JSON with `confirmedTrends` and `aiFlaggedObservations`; `extractJSON()` handles markdown-wrapped responses
- **Claude recommender** — returns exactly 12 recommendations; tiers correctly assigned by confidence score; `.json` and `.txt` files saved
- **Dashboard** — loads state, renders charts, displays 12 rec cards with approve/reject buttons, updates in real time on Socket.io events
- **Approve/reject flow** — decisions persisted to `approval-history.json`, rec `.json` files updated, UI updates via Socket.io, daily cap enforced
- **Email** — dark-themed HTML brief delivered to `chasezaidan@eatrollin.food` with trends, recommendations, and dashboard link
- **`--test` mode** — loads cached `raw-data/` and runs all post-scrape steps without hitting Apify
- **`--dev` mode** — full pipeline runs immediately on startup
- **Log rotation** — new log file correctly created at midnight Detroit time
- **Prompt size reduction** — top 20 by composite score, slim fields only; prompt is ~50% smaller vs. prior 40-video full-detail format
- **300-second API timeout** — set at Anthropic client level; prevents hanging on slow Claude responses

---

## 7. Untested / Not Yet Validated

**Higgsfield video rendering (end-to-end)**  
Submissions have been sent and `jobId` returned, but the full render-to-completion flow has not been observed. `checkJobStatus()` logic is untested against a real completed job. The `renderLink` field in the response is assumed but not verified.

**Higgsfield multipart footage upload**  
The code path that sends raw footage as a multipart form body (when matching files exist in `CONTENT_LIBRARY_PATH`) has not been tested end-to-end with a real video file. The JSON-only (text-to-video) path has been used instead.

**Learning loop at full maturity**  
72h checkpoint logic and `buildLearningContext()` with real approved/rejected @eatrollin posts has not been tested. The system is pre-launch — @eatrollin has no post history yet. The 24h checkpoint will first trigger ~22 hours after the first post goes live.

**Day-over-day email performance delta**  
The `dayOverDay` calculation in `learningLoop.js` and the corresponding display in the email require at least 2 days of @eatrollin post history. Not yet exercised.

**Approval history cross-referencing in learning loop**  
`learningLoop.js` attempts to match scraped @eatrollin posts against `approval-history.json` by URL or caption similarity. This logic has not been tested with real data (no approvals have been followed by actual @eatrollin posts yet).

**`checkJobStatus()` dashboard polling**  
The `/api/higgsfield/:jobId` endpoint exists and calls `higgsfield.checkJobStatus()`, but has not been exercised through the dashboard UI against a real Higgsfield job in progress.

**High-volume scrape days**  
Behavior when Apify returns close to the maximum (150 TikTok + 100 Instagram items per source) has not been stress-tested. The KPI scorer, transcriber, and Claude prompt size are all sensitive to dataset size.

**Gmail app password rotation**  
What happens if the Gmail app password expires or is revoked mid-run has not been tested. The emailer logs the error and returns `{ success: false }` but the rest of the pipeline is unaffected.

**Multiple simultaneous dashboard connections**  
Socket.io event broadcasting with more than one connected browser tab has not been tested.

**Cron schedule via `CRON_SCHEDULE` env var**  
The default `0 6 * * *` schedule has been verified. Custom schedules via the env var have not been tested.

---

## 8. Key Constants & Hardcoded Values

### KPI Formula Weights (frozen — do not change)

| Constant | Value | File |
|----------|-------|------|
| `BASE_WEIGHTS.shareRate` | `0.50` | `kpiScorer.js` |
| `BASE_WEIGHTS.saveRate` | `0.30` | `kpiScorer.js` |
| `BASE_WEIGHTS.commentRate` | `0.20` | `kpiScorer.js` |
| `COMPOSITE_WEIGHTS.base` | `0.70` | `kpiScorer.js` |
| `COMPOSITE_WEIGHTS.dynamic` | `0.30` | `kpiScorer.js` |
| Dynamic: velocity weight | `0.50` | `kpiScorer.js` |
| Dynamic: audio reuse weight | `0.20` | `kpiScorer.js` |
| Dynamic: hashtag freq weight | `0.20` | `kpiScorer.js` |
| Dynamic: posting time weight | `0.10` | `kpiScorer.js` |
| KPI threshold | 40th percentile | `kpiScorer.js` |

### Volume & Capacity Limits

| Constant | Value | File | Notes |
|----------|-------|------|-------|
| `TIKTOK_HASHTAG_MAX` | `150` | `scraper.js` | Per hashtag |
| `INSTAGRAM_MAX` | `100` | `scraper.js` | Per account |
| `HOURS_BACK` | `24` | `scraper.js` | Videos older than 24h are dropped |
| `TOP_VIDEOS_LIMIT` | `20` | `analyzer.js` | Videos sent to Claude |
| `TOTAL_RECS` | `12` | `recommender.js` | Must be exactly this count |
| `AUTO_SUBMIT_COUNT` | `2` | `higgsfield.js` | Top High-tier recs auto-submitted |
| `MAX_APPROVALS_PER_DAY` | `12` | `approvalManager.js` | Hard daily cap |
| `MAX_OWN_POSTS` | `30` | `learningLoop.js` | Per platform for @eatrollin |

### Timeouts

| Constant | Value | File |
|----------|-------|------|
| Anthropic client timeout | `300,000 ms` | `analyzer.js` |
| Apify actor timeout | `300 s` | `scraper.js`, `learningLoop.js` |
| `DOWNLOAD_TIMEOUT` | `45,000 ms` | `transcriber.js` |
| `TRANSCRIBE_TIMEOUT` | `90,000 ms` | `transcriber.js` |
| `REQUEST_TIMEOUT_MS` | `30,000 ms` | `higgsfield.js` |

### Brand Hardcoding

The following are baked directly into system prompts and templates — changing them requires editing source files, not env vars:

| Item | Value | Location |
|------|-------|----------|
| Restaurant name | Rollin | Throughout |
| Concept | Premium Asian fusion ghost kitchen | `analyzer.js`, `recommender.js` system prompts |
| Location | Detroit, Michigan | `analyzer.js`, `recommender.js` system prompts |
| Opening date | June 1st | `analyzer.js`, `recommender.js` system prompts |
| Handle | @eatrollin | `learningLoop.js` (`EATROLLIN_HANDLE`), prompts, emailer |
| Email recipient | chasezaidan@eatrollin.food | `emailer.js` |
| Model (both Claude calls) | claude-sonnet-4-6 | `analyzer.js`, `recommender.js` |
| Cron timezone | America/Detroit | `scheduler.js`, `logger.js` |
| Dashboard port | 3000 | `dashboard/server.js` (also `DASHBOARD_PORT` env var) |

---

## 9. Data Files Reference

### `data/approval-history.json`
All approve/reject decisions. Shape:
```json
{
  "decisions": [
    {
      "id": "...",
      "decision": "approved | rejected",
      "recommendationId": "rec_01_...",
      "recommendationTitle": "...",
      "tier": "high | medium | low",
      "confidenceScore": 9,
      "label": "KPI-CONFIRMED | AI-FLAGGED",
      "date": "2026-04-13",
      "approvedAt": "ISO timestamp",
      "note": "optional rejection note",
      "postUrl": "...",
      "caption": "...",
      "hashtagSet": [],
      "sourceTrendId": "trend_001"
    }
  ]
}
```

### `data/performance-history.json`
@eatrollin post tracking. Shape:
```json
{
  "updatedAt": "ISO timestamp",
  "posts": [
    {
      "id": "...",
      "platform": "tiktok | instagram",
      "url": "...",
      "caption": "...",
      "postedAt": "ISO timestamp",
      "latestMetrics": { "recordedAt": "...", "viewCount": 0, "kpiScore": 0 },
      "checkpoints": {
        "24h": { "recordedAt": "...", "viewCount": 0, "kpiScore": 0 },
        "72h": { "recordedAt": "...", "viewCount": 0, "kpiScore": 0, "isFinal": true }
      },
      "wasRecommended": false,
      "wasApproved": false,
      "wasRejected": false,
      "actualPerformance": "pending | evaluated"
    }
  ]
}
```

### `raw-data/YYYY-MM-DD.json`
Raw scrape output. Used in `--test` mode to skip Apify:
```json
{
  "date": "2026-04-13",
  "scrapedAt": "ISO timestamp",
  "totalVideos": 0,
  "tiktokCount": 0,
  "instagramCount": 0,
  "note": "Instagram shareCount and saveCount are always 0",
  "videos": []
}
```

---

## 10. npm Scripts

| Script | Command | When to use |
|--------|---------|-------------|
| `npm start` | `node index.js` | Production: starts dashboard + scheduler (fires 6am daily) |
| `npm run dev` | `node index.js --dev` | Development: starts dashboard + runs pipeline immediately |
| `npm run pipeline` | `node src/pipeline.js` | Manual one-off pipeline run without restarting the server |
| `npm run dashboard` | `node src/dashboard/server.js` | Dashboard only — no scheduler, no pipeline |

All commands must be run from the project root after `npm install`. Node.js >= 18.0.0 required.
