require('dotenv').config();

const sgMail    = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const logger     = require('./logger');

// ─── Config ───────────────────────────────────────────────────────────────────
const RECIPIENT      = 'chasezaidan@eatrollin.food';
const DASHBOARD_URL  = process.env.DASHBOARD_URL ||
  (process.env.NODE_ENV === 'production' ? '' : `http://localhost:${process.env.PORT || process.env.DASHBOARD_PORT || 3000}`);
const BRAND_GOLD     = '#c8a96e';
const BRAND_BG       = '#0a0a0a';
const BRAND_CARD     = '#111111';
const BRAND_BORDER   = '#1e1e1e';
const BRAND_GRAY     = '#888888';
const BRAND_WHITE    = '#ffffff';

// ─── Nodemailer transport ─────────────────────────────────────────────────────
function createTransport() {
  return nodemailer.createTransport({
    host:             'smtp.gmail.com',
    port:             465,
    secure:           true,
    connectionTimeout: 30_000,
    socketTimeout:     30_000,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
    tls: { rejectUnauthorized: false },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pct(value) {
  if (value === null || value === undefined) return 'N/A';
  const sign = value > 0 ? '+' : '';
  return `${sign}${Number(value).toFixed(1)}%`;
}

function dodColor(value) {
  if (value === null || value === undefined) return BRAND_GRAY;
  return value > 0 ? '#5cbf5c' : value < 0 ? '#bf5c5c' : BRAND_GRAY;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Extract data from pipeline state ────────────────────────────────────────
function extractData(state) {
  const scraped       = state.scrapedVideos?.length ?? 0;
  const passedKpi     = (state.scoredVideos || []).filter(v => v.kpi?.passedKpiThreshold).length;
  const recs          = state.recommendations || [];
  const analysis      = state.trendAnalysis   || {};
  const loopResult    = state.ownPostPerformance || {};
  const dayOverDay    = loopResult.dayOverDay  || {};

  // Top 3 confirmed trends, fall back to AI-flagged if needed
  const confirmedTrends  = analysis.confirmedTrends        || [];
  const flaggedObs       = analysis.aiFlaggedObservations  || [];
  const topTrends = [...confirmedTrends, ...flaggedObs].slice(0, 3);

  // Top 3 recommendations by confidence score
  const topRecs = [...recs].sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0)).slice(0, 3);

  return { scraped, passedKpi, recs, topTrends, topRecs, dayOverDay };
}

// ─── Build HTML email ─────────────────────────────────────────────────────────
function buildHTML(data, date) {
  const { scraped, passedKpi, recs, topTrends, topRecs, dayOverDay } = data;

  const dodPct   = dayOverDay.changePercent ?? null;
  const dodColor = dodColor2(dodPct);
  const dodLabel = dodPct !== null ? `${dodPct > 0 ? '↑' : dodPct < 0 ? '↓' : '→'} ${pct(dodPct)} vs prior day` : 'No comparison data yet';

  // ── Trend rows ─────────────────────────────────────────────────────────────
  const trendRows = topTrends.map((t, i) => {
    const labelTxt = t.label === 'AI-FLAGGED' ? 'AI-FLAGGED' : 'KPI-CONFIRMED';
    const labelClr = t.label === 'AI-FLAGGED' ? '#6e8fc8' : BRAND_GOLD;
    const summary  = esc((t.summary || '').slice(0, 280));
    return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid ${BRAND_BORDER};">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="min-width:20px;font-family:monospace;font-size:18px;color:${BRAND_BORDER};font-weight:700;line-height:1.4;">${i + 1}</div>
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:9px;letter-spacing:0.2em;font-weight:700;color:${labelClr};background:${labelClr}18;padding:2px 7px;border-radius:2px;">${labelTxt}</span>
            </div>
            <div style="font-size:13px;font-weight:700;color:${BRAND_WHITE};margin-bottom:6px;">${esc(t.title || '')}</div>
            <div style="font-size:13px;color:#aaaaaa;line-height:1.6;">${summary}</div>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');

  // ── Rec cards ──────────────────────────────────────────────────────────────
  const recCards = topRecs.map((r, i) => {
    const tierClr  = r.tier === 'high' ? BRAND_GOLD : r.tier === 'medium' ? '#9999aa' : '#555566';
    const tierTxt  = (r.tier || 'low').toUpperCase();
    const conf     = r.confidenceScore || 0;
    const dots     = Array.from({ length: 10 }, (_, j) => `<span style="color:${j < conf ? BRAND_GOLD : '#222'};font-size:10px;">●</span>`).join('');
    return `
    <td style="width:33.3%;padding:0 6px;vertical-align:top;">
      <div style="background:#161616;border:1px solid ${BRAND_BORDER};border-radius:6px;padding:14px;">
        <div style="font-size:9px;letter-spacing:0.2em;color:${tierClr};font-weight:700;margin-bottom:8px;">${tierTxt}</div>
        <div style="font-size:12px;font-weight:700;color:${BRAND_WHITE};margin-bottom:10px;line-height:1.4;">${esc((r.title || '').slice(0, 50))}</div>
        <div style="margin-bottom:6px;">${dots}</div>
        <div style="font-size:11px;color:${BRAND_GRAY};">${conf}/10 confidence</div>
      </div>
    </td>`;
  }).join('');

  // Pad to 3 columns if fewer than 3 recs
  const paddedRecs = recCards + Array(Math.max(0, 3 - topRecs.length))
    .fill(`<td style="width:33.3%;padding:0 6px;"></td>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="color-scheme" content="dark"/>
  <title>Rollin Content Engine — ${date}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND_BG};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">

  <!-- Preheader -->
  <div style="display:none;max-height:0;overflow:hidden;color:${BRAND_BG};">
    ${scraped} videos scraped · ${passedKpi} passed KPI · ${recs.length} recommendations ready — ${date}
  </div>

  <!-- Wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND_BG};min-height:100vh;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- Email container -->
        <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

          <!-- ── HEADER ──────────────────────────────────────────────────── -->
          <tr>
            <td style="padding:0 0 24px 0;border-bottom:1px solid ${BRAND_BORDER};">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="font-size:20px;font-weight:700;letter-spacing:0.15em;color:${BRAND_WHITE};">ROLLIN</div>
                    <div style="font-size:9px;letter-spacing:0.25em;color:${BRAND_GRAY};margin-top:2px;">CONTENT ENGINE</div>
                  </td>
                  <td align="right">
                    <div style="font-size:11px;color:${BRAND_GRAY};font-family:monospace;">${date}</div>
                    <div style="font-size:10px;color:#333;margin-top:2px;">Daily Intelligence Brief</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- spacer -->
          <tr><td style="height:24px;"></td></tr>

          <!-- ── STATS ROW ───────────────────────────────────────────────── -->
          <tr>
            <td>
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="33%" style="text-align:center;padding:16px;background:${BRAND_CARD};border:1px solid ${BRAND_BORDER};border-radius:6px 0 0 6px;">
                    <div style="font-size:28px;font-weight:700;color:${BRAND_WHITE};font-family:monospace;">${scraped}</div>
                    <div style="font-size:9px;letter-spacing:0.15em;color:${BRAND_GRAY};margin-top:4px;">SCRAPED</div>
                  </td>
                  <td width="1px" style="background:${BRAND_BG};"></td>
                  <td width="33%" style="text-align:center;padding:16px;background:${BRAND_CARD};border-top:1px solid ${BRAND_BORDER};border-bottom:1px solid ${BRAND_BORDER};">
                    <div style="font-size:28px;font-weight:700;color:${BRAND_GOLD};font-family:monospace;">${passedKpi}</div>
                    <div style="font-size:9px;letter-spacing:0.15em;color:${BRAND_GRAY};margin-top:4px;">PASSED KPI</div>
                  </td>
                  <td width="1px" style="background:${BRAND_BG};"></td>
                  <td width="33%" style="text-align:center;padding:16px;background:${BRAND_CARD};border:1px solid ${BRAND_BORDER};border-radius:0 6px 6px 0;">
                    <div style="font-size:28px;font-weight:700;color:${BRAND_WHITE};font-family:monospace;">${recs.length}</div>
                    <div style="font-size:9px;letter-spacing:0.15em;color:${BRAND_GRAY};margin-top:4px;">RECOMMENDATIONS</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- spacer -->
          <tr><td style="height:32px;"></td></tr>

          <!-- ── @EATROLLIN PERFORMANCE ──────────────────────────────────── -->
          <tr>
            <td style="background:${BRAND_CARD};border:1px solid ${BRAND_BORDER};border-radius:6px;padding:20px;">
              <div style="font-size:9px;letter-spacing:0.25em;font-weight:700;color:${BRAND_GRAY};margin-bottom:12px;">@EATROLLIN PERFORMANCE</div>
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="font-size:22px;font-weight:700;color:${dodColor};font-family:monospace;">${dodPct !== null ? pct(dodPct) : '—'}</div>
                    <div style="font-size:12px;color:${BRAND_GRAY};margin-top:4px;">${dodLabel}</div>
                  </td>
                  <td align="right" style="vertical-align:top;">
                    <div style="font-size:10px;color:#333;text-align:right;">
                      Yesterday posts: ${dayOverDay.yesterdayPostCount ?? '—'}<br/>
                      Prior day posts: ${dayOverDay.twoDaysAgoPostCount ?? '—'}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- spacer -->
          <tr><td style="height:32px;"></td></tr>

          <!-- ── TOP 3 TRENDS ────────────────────────────────────────────── -->
          <tr>
            <td>
              <div style="font-size:9px;letter-spacing:0.25em;font-weight:700;color:${BRAND_GRAY};margin-bottom:4px;">TOP TRENDS TODAY</div>
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${trendRows || `<tr><td style="padding:16px 0;color:${BRAND_GRAY};font-size:13px;">No trend data yet — pipeline has not run.</td></tr>`}
              </table>
            </td>
          </tr>

          <!-- spacer -->
          <tr><td style="height:32px;"></td></tr>

          <!-- ── TOP 3 RECOMMENDATIONS ───────────────────────────────────── -->
          <tr>
            <td>
              <div style="font-size:9px;letter-spacing:0.25em;font-weight:700;color:${BRAND_GRAY};margin-bottom:16px;">TOP RECOMMENDATIONS</div>
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr style="margin:0 -6px;">
                  ${paddedRecs || `<td style="color:${BRAND_GRAY};font-size:13px;padding:16px 0;">No recommendations yet.</td>`}
                </tr>
              </table>
            </td>
          </tr>

          <!-- spacer -->
          <tr><td style="height:32px;"></td></tr>

          <!-- ── CTA BUTTON ──────────────────────────────────────────────── -->
          <tr>
            <td align="center">
              <a href="${DASHBOARD_URL}"
                 style="display:inline-block;background:${BRAND_GOLD};color:#000000;font-size:11px;font-weight:700;letter-spacing:0.2em;text-decoration:none;padding:14px 40px;border-radius:4px;">
                OPEN DASHBOARD
              </a>
              <div style="margin-top:10px;font-size:11px;color:#333;">${DASHBOARD_URL}</div>
            </td>
          </tr>

          <!-- spacer -->
          <tr><td style="height:40px;"></td></tr>

          <!-- ── FOOTER ──────────────────────────────────────────────────── -->
          <tr>
            <td style="border-top:1px solid ${BRAND_BORDER};padding-top:20px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="font-size:10px;color:#333;">
                      Rollin Content Engine · Detroit, MI<br/>
                      Premium Asian Fusion Ghost Kitchen · Opens June 1st
                    </div>
                  </td>
                  <td align="right">
                    <div style="font-size:10px;color:#222;">@eatrollin</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- bottom spacer -->
          <tr><td style="height:32px;"></td></tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

// Shared helper (can't use closures inside template literal)
function dodColor2(val) {
  if (val === null || val === undefined) return BRAND_GRAY;
  return val > 0 ? '#5cbf5c' : val < 0 ? '#bf5c5c' : BRAND_GRAY;
}

// ─── Build plain-text fallback ────────────────────────────────────────────────
function buildText(data, date) {
  const { scraped, passedKpi, recs, topTrends, topRecs, dayOverDay } = data;
  const dodPct = dayOverDay.changePercent ?? null;

  const lines = [
    `ROLLIN CONTENT ENGINE — ${date}`,
    '─'.repeat(48),
    '',
    `STATS: ${scraped} scraped · ${passedKpi} passed KPI · ${recs.length} recommendations`,
    '',
    `@EATROLLIN: ${dodPct !== null ? pct(dodPct) + ' vs yesterday' : 'No comparison data yet'}`,
    '',
    'TOP TRENDS',
    '─'.repeat(48),
    ...topTrends.map((t, i) => [
      `${i + 1}. [${t.label || 'KPI-CONFIRMED'}] ${t.title || ''}`,
      `   ${(t.summary || '').slice(0, 200)}`,
      '',
    ]).flat(),
    'TOP RECOMMENDATIONS',
    '─'.repeat(48),
    ...topRecs.map(r => `  #${r.rank || '?'} [${(r.tier || '').toUpperCase()}] ${r.title || ''} — ${r.confidenceScore || 0}/10`),
    '',
    `Open dashboard: ${DASHBOARD_URL}`,
    '',
    'Rollin · Detroit MI · @eatrollin',
  ];
  return lines.join('\n');
}

// ─── SendGrid send ────────────────────────────────────────────────────────────
async function sendViaSendGrid(subject, text, html) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    from:    { email: process.env.EMAIL_USER || 'noreply@eatrollin.food', name: 'Rollin Content Engine' },
    to:      RECIPIENT,
    subject,
    text,
    html,
  });
}

// ─── Nodemailer fallback send ─────────────────────────────────────────────────
async function sendViaNodemailer(subject, text, html) {
  const transporter = createTransport();
  await transporter.verify();
  logger.info('[Email] SMTP connection verified.');
  const info = await transporter.sendMail({
    from:    `"Rollin Content Engine" <${process.env.EMAIL_USER}>`,
    to:      RECIPIENT,
    subject,
    text,
    html,
  });
  return info.messageId;
}

// ─── Main send function ───────────────────────────────────────────────────────
async function send(state) {
  logger.info('[Email] ─────────────────────────────────────────────');
  logger.info('[Email] Preparing daily brief...');

  const now  = new Date();
  const date = now.toLocaleDateString('en-US', { timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

  const data    = extractData(state);
  const html    = buildHTML(data, date);
  const text    = buildText(data, date);
  const subject = `Rollin Content Engine · ${date} · ${data.recs.length} Recommendations Ready`;

  logger.info(`[Email] To: ${RECIPIENT}`);
  logger.info(`[Email] Subject: ${subject}`);
  logger.info(`[Email] Trends: ${data.topTrends.length} · Recs: ${data.topRecs.length} · Scraped: ${data.scraped}`);

  // ── Primary: SendGrid ───────────────────────────────────────────────────────
  if (process.env.SENDGRID_API_KEY) {
    try {
      await sendViaSendGrid(subject, text, html);
      logger.info('[Email] ✓ Sent via SendGrid.');
      logger.info('[Email] ─────────────────────────────────────────────');
      return { success: true, transport: 'sendgrid' };
    } catch (err) {
      logger.error(`[Email] ✗ SendGrid failed: ${err.message}`);
      logger.warn('[Email] Falling back to Nodemailer SMTP...');
    }
  } else {
    logger.warn('[Email] SENDGRID_API_KEY not set — falling back to Nodemailer SMTP.');
  }

  // ── Fallback: Nodemailer SMTP ───────────────────────────────────────────────
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    logger.error('[Email] EMAIL_USER or EMAIL_PASSWORD not set — cannot fall back. Skipping.');
    logger.info('[Email] ─────────────────────────────────────────────');
    return { success: false, error: 'No email transport available (SENDGRID_API_KEY and SMTP credentials both missing)' };
  }

  try {
    const messageId = await sendViaNodemailer(subject, text, html);
    logger.info(`[Email] ✓ Sent via Nodemailer — Message ID: ${messageId}`);
    logger.info('[Email] ─────────────────────────────────────────────');
    return { success: true, transport: 'nodemailer', messageId };
  } catch (err) {
    logger.error(`[Email] ✗ Nodemailer failed: ${err.message}`);
    logger.info('[Email] ─────────────────────────────────────────────');
    return { success: false, error: err.message };
  }
}

module.exports = { send };
