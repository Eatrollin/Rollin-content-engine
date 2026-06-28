// ─── Brand ────────────────────────────────────────────────────────────────────
const BG      = '#0a0a0a';
const CARD    = '#111111';
const CARD2   = '#161616';
const BORDER  = '#1e1e1e';
const BORDER2 = '#2a2a2a';
const GOLD    = '#c8a96e';
const WHITE   = '#ffffff';
const GRAY    = '#888888';
const GRAY2   = '#cccccc';
const GRAY3   = '#444444';

function esc(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tierColor(tier) {
  if (tier === 'high')   return GOLD;
  if (tier === 'medium') return '#9999aa';
  return '#555566';
}

// Returns a <tr><td>…</td></tr> block, or '' when content is empty.
function section(label, content) {
  if (!content) return '';
  return `
          <tr>
            <td style="padding:24px 0 0 0;">
              <div style="font-size:9px;letter-spacing:0.25em;font-weight:700;color:${GRAY};border-bottom:1px solid ${BORDER};padding-bottom:8px;margin-bottom:14px;">${label}</div>
              ${content}
            </td>
          </tr>`;
}

// ─── buildEditorEmail ─────────────────────────────────────────────────────────
function buildEditorEmail(rec) {
  const brief = rec.contentBrief      || {};
  const prod  = rec.productionPackage || {};
  const tier  = (rec.tier || 'low');
  const tc    = tierColor(tier);

  const subject = `Rollin — Edit Brief: ${rec.title || 'Untitled'}`;

  // ── Overview header ─────────────────────────────────────────────────────────
  const statCells = [];
  if (prod.finalVideoDuration) {
    statCells.push(`
      <td style="text-align:center;padding:14px;background:${CARD};border:1px solid ${BORDER};border-radius:4px 0 0 4px;">
        <div style="font-size:20px;font-weight:700;color:${GOLD};font-family:monospace;">${esc(prod.finalVideoDuration)}</div>
        <div style="font-size:9px;letter-spacing:0.15em;color:${GRAY};margin-top:4px;">FINAL LENGTH</div>
      </td>
      <td style="width:2px;background:${BG};"></td>`);
  }
  if (prod.totalClipsToShoot) {
    const isFirst = statCells.length === 0;
    statCells.push(`
      <td style="text-align:center;padding:14px;background:${CARD};border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};${isFirst ? 'border-left:1px solid ' + BORDER + ';border-radius:4px 0 0 4px;' : ''}">
        <div style="font-size:20px;font-weight:700;color:${WHITE};font-family:monospace;">${esc(prod.totalClipsToShoot)}</div>
        <div style="font-size:9px;letter-spacing:0.15em;color:${GRAY};margin-top:4px;">CLIPS</div>
      </td>
      <td style="width:2px;background:${BG};"></td>`);
  }
  if (prod.estimatedShootTime) {
    const isFirst = statCells.length === 0;
    statCells.push(`
      <td style="text-align:center;padding:14px;background:${CARD};border:1px solid ${BORDER};border-radius:${isFirst ? '4px 4px 4px 4px' : '0 4px 4px 0'};">
        <div style="font-size:20px;font-weight:700;color:${WHITE};font-family:monospace;">${esc(prod.estimatedShootTime)}</div>
        <div style="font-size:9px;letter-spacing:0.15em;color:${GRAY};margin-top:4px;">SHOOT TIME</div>
      </td>`);
  } else if (statCells.length) {
    // Remove trailing separator td
    statCells[statCells.length - 1] = statCells[statCells.length - 1].replace(/<td style="width:2px[^>]+><\/td>$/, '');
    // Close last stat cell with correct right border-radius
    statCells[statCells.length - 1] = statCells[statCells.length - 1].replace('border-radius:4px 0 0 4px', 'border-radius:4px 4px 4px 4px');
  }

  const headerHtml = `
    <div style="background:${CARD2};border:1px solid ${BORDER};border-radius:6px;padding:20px 20px 16px;">
      <div style="font-size:9px;letter-spacing:0.25em;color:${tc};font-weight:700;margin-bottom:6px;">${esc(tier.toUpperCase())}</div>
      <div style="font-size:24px;font-weight:700;color:${WHITE};line-height:1.3;margin-bottom:${statCells.length ? '16px' : '0'};">${esc(rec.title || 'Untitled')}</div>
      ${statCells.length ? `<table cellpadding="0" cellspacing="0" border="0"><tr>${statCells.join('')}</tr></table>` : ''}
    </div>`;

  // ── Hook ────────────────────────────────────────────────────────────────────
  const hookHtml = brief.hook
    ? `<div style="background:${CARD2};border-left:3px solid ${GOLD};padding:14px 16px;border-radius:0 4px 4px 0;font-size:15px;color:${WHITE};line-height:1.5;font-weight:600;">"${esc(brief.hook)}"</div>`
    : '';

  // ── Script / beats ──────────────────────────────────────────────────────────
  const scriptItems = brief.scriptOutline || [];
  const scriptHtml  = scriptItems.length
    ? `<ol style="margin:0;padding:0 0 0 20px;">
        ${scriptItems.map(l => `<li style="font-size:13px;color:${GRAY2};line-height:1.6;padding:4px 0;border-bottom:1px solid ${BORDER};">${esc(l)}</li>`).join('')}
       </ol>`
    : '';

  // ── Music & audio ───────────────────────────────────────────────────────────
  const musicHtml = prod.musicAndAudioPlan
    ? `<div style="background:${CARD2};border:1px solid ${BORDER};padding:12px 14px;border-radius:4px;font-size:13px;color:${GRAY2};line-height:1.6;">${esc(prod.musicAndAudioPlan)}</div>`
    : '';

  // ── Edit order table (most important) ───────────────────────────────────────
  const editOrder = prod.editOrder || [];
  let editOrderSection = '';
  if (editOrder.length) {
    const rows = editOrder.map((slot, i) => `
        <tr style="background:${i % 2 === 0 ? CARD : CARD2};">
          <td style="font-size:12px;font-weight:700;color:${GOLD};padding:10px 10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(slot.slotNumber != null ? slot.slotNumber : i + 1)}</td>
          <td style="font-size:12px;color:${WHITE};font-family:monospace;padding:10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(slot.timestamp || '—')}</td>
          <td style="font-size:12px;font-weight:700;color:${WHITE};padding:10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(slot.shootClipRef || '—')}</td>
          <td style="font-size:12px;color:${GRAY2};padding:10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(slot.finalDuration || '—')}</td>
          <td style="font-size:12px;color:#e8c98a;padding:10px;border:1px solid ${BORDER};line-height:1.4;">${slot.onScreenText ? `"${esc(slot.onScreenText)}"` : `<span style="color:${GRAY3};">—</span>`}</td>
          <td style="font-size:12px;color:${GRAY};padding:10px;border:1px solid ${BORDER};line-height:1.4;">${esc(slot.audioCue || '—')}</td>
          <td style="font-size:12px;color:${GRAY};padding:10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(slot.transitionIn || '—')}</td>
        </tr>`).join('');

    editOrderSection = `
          <tr>
            <td style="padding:24px 0 0 0;">
              <div style="font-size:9px;letter-spacing:0.25em;font-weight:700;color:${GOLD};border-bottom:2px solid ${GOLD};padding-bottom:8px;margin-bottom:12px;">EDIT ORDER — BUILD YOUR TIMELINE</div>
              <div style="font-size:11px;color:${GRAY};margin-bottom:12px;">Work top to bottom in CapCut. Each row tells you which shoot clip to drop in and what goes on screen at that moment.</div>
              <div style="overflow-x:auto;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;min-width:520px;">
                <thead>
                  <tr style="background:${CARD2};">
                    <th style="font-size:9px;letter-spacing:0.15em;color:${GOLD};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">#</th>
                    <th style="font-size:9px;letter-spacing:0.15em;color:${GOLD};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">TIMESTAMP</th>
                    <th style="font-size:9px;letter-spacing:0.15em;color:${GOLD};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">FOOTAGE REF</th>
                    <th style="font-size:9px;letter-spacing:0.15em;color:${GOLD};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">DURATION</th>
                    <th style="font-size:9px;letter-spacing:0.15em;color:${GOLD};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};">ON-SCREEN TEXT</th>
                    <th style="font-size:9px;letter-spacing:0.15em;color:${GOLD};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};">AUDIO CUE</th>
                    <th style="font-size:9px;letter-spacing:0.15em;color:${GOLD};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">TRANSITION IN</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
              </div>
            </td>
          </tr>`;
  }

  // ── Shoot list table ────────────────────────────────────────────────────────
  const shootList = prod.shootList || [];
  let shootHtml = '';
  if (shootList.length) {
    const rows = shootList.map((clip, i) => `
        <tr style="background:${i % 2 === 0 ? CARD : CARD2};">
          <td style="font-size:12px;font-weight:700;color:${GOLD};padding:8px 10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(clip.clipNumber != null ? clip.clipNumber : i + 1)}</td>
          <td style="font-size:12px;font-weight:600;color:${WHITE};padding:8px 10px;border:1px solid ${BORDER};line-height:1.4;">${esc(clip.subject || '—')}</td>
          <td style="font-size:12px;color:${GRAY2};padding:8px 10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(clip.cameraAngle || '—')}</td>
          <td style="font-size:12px;color:${GRAY2};padding:8px 10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(clip.shotDistance || '—')}</td>
          <td style="font-size:12px;color:${GRAY2};padding:8px 10px;border:1px solid ${BORDER};white-space:nowrap;">${esc(clip.cameraMovement || '—')}</td>
          <td style="font-size:12px;font-weight:600;color:#e8c98a;padding:8px 10px;border:1px solid ${BORDER};line-height:1.4;">${esc(clip.criticalDetail || '—')}</td>
        </tr>`).join('');

    shootHtml = `
      <div style="overflow-x:auto;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;min-width:460px;">
        <thead>
          <tr style="background:${CARD2};">
            <th style="font-size:9px;letter-spacing:0.15em;color:${GRAY};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">CLIP</th>
            <th style="font-size:9px;letter-spacing:0.15em;color:${GRAY};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};">SUBJECT</th>
            <th style="font-size:9px;letter-spacing:0.15em;color:${GRAY};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">ANGLE</th>
            <th style="font-size:9px;letter-spacing:0.15em;color:${GRAY};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">DISTANCE</th>
            <th style="font-size:9px;letter-spacing:0.15em;color:${GRAY};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};white-space:nowrap;">MOVEMENT</th>
            <th style="font-size:9px;letter-spacing:0.15em;color:${GRAY};font-weight:700;padding:8px 10px;text-align:left;border:1px solid ${BORDER2};">CRITICAL DETAIL</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      </div>`;
  }

  // ── Caption & hashtags ──────────────────────────────────────────────────────
  const tags = (brief.hashtagSet || []).map(t =>
    `<span style="display:inline-block;font-size:11px;color:${GOLD};font-family:monospace;margin:2px 4px 2px 0;">#${esc(t)}</span>`
  ).join('');

  let captionHtml = '';
  if (brief.sampleCaption || tags || brief.callToAction) {
    captionHtml = `
      ${brief.sampleCaption ? `<div style="background:${CARD2};border-left:3px solid ${BORDER2};padding:10px 14px;border-radius:0 4px 4px 0;font-size:13px;color:${GRAY2};font-style:italic;line-height:1.5;margin-bottom:10px;">"${esc(brief.sampleCaption)}"</div>` : ''}
      ${brief.callToAction ? `<div style="font-size:12px;margin-bottom:8px;"><span style="font-size:9px;letter-spacing:0.15em;color:${GRAY3};font-weight:700;">CTA  </span><span style="color:${GRAY2};">${esc(brief.callToAction)}</span></div>` : ''}
      ${tags ? `<div style="margin-top:4px;">${tags}</div>` : ''}`;
  }

  // ── Footage note ────────────────────────────────────────────────────────────
  let footageHtml = '';
  if (rec.rawFootageNote) {
    let driveNote = '';
    const fm = rec.footageMatch;
    if (fm) {
      if (fm.type === 'seedance-ready') {
        driveNote = `<div style="font-size:12px;color:#5cbf5c;margin-top:8px;">&#10003; Matching footage found in Drive — SEEDANCE-READY</div>`;
        if (fm.matchedFiles && fm.matchedFiles.length) {
          driveNote += `<div style="font-size:11px;color:${GRAY};margin-top:4px;">${fm.matchedFiles.map(f => `&#9658; ${esc(f)}`).join('<br/>')}</div>`;
        }
      } else if (fm.type === 'needs-shoot') {
        driveNote = `<div style="font-size:12px;color:#c8c86e;margin-top:8px;">&#9889; No matching footage — needs original shoot</div>`;
      }
    } else if (rec.footage) {
      driveNote = `<div style="font-size:12px;color:${GRAY};margin-top:8px;">Drive: ${esc(rec.footage)}</div>`;
    }
    footageHtml = `
      <div style="background:${CARD2};border:1px solid ${BORDER};padding:12px 14px;border-radius:4px;font-size:13px;color:${GRAY2};line-height:1.6;">
        ${esc(rec.rawFootageNote)}
        ${driveNote}
      </div>`;
  }

  // ── Assemble ────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="color-scheme" content="dark"/>
  <title>Rollin Edit Brief — ${esc(rec.title || 'Untitled')}</title>
</head>
<body style="margin:0;padding:0;background-color:${BG};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};min-height:100vh;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;">

          <!-- NAV -->
          <tr>
            <td style="padding:0 0 20px 0;border-bottom:1px solid ${BORDER};">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="font-size:18px;font-weight:700;letter-spacing:0.15em;color:${WHITE};">ROLLIN</div>
                    <div style="font-size:9px;letter-spacing:0.25em;color:${GRAY};margin-top:2px;">CONTENT ENGINE — EDIT BRIEF</div>
                  </td>
                  <td align="right">
                    <div style="font-size:10px;color:${GRAY3};font-family:monospace;">For editor eyes only</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- spacer -->
          <tr><td style="height:24px;"></td></tr>

          <!-- OVERVIEW -->
          <tr><td>${headerHtml}</td></tr>

          ${section('THE HOOK', hookHtml)}
          ${section('SCRIPT / BEATS', scriptHtml)}
          ${section('MUSIC &amp; AUDIO PLAN', musicHtml)}
          ${editOrderSection}
          ${section('SHOT REFERENCE — WHAT EACH CLIP IS', shootHtml)}
          ${section('CAPTION &amp; HASHTAGS', captionHtml)}
          ${section('FOOTAGE NOTE', footageHtml)}

          <!-- spacer -->
          <tr><td style="height:40px;"></td></tr>

          <!-- FOOTER -->
          <tr>
            <td style="border-top:1px solid ${BORDER};padding-top:20px;">
              <div style="font-size:10px;color:${GRAY3};">
                Rollin Content Engine &middot; @eatrollin &middot; Detroit, MI<br/>
                Questions? Reply to this email.
              </div>
            </td>
          </tr>

          <tr><td style="height:32px;"></td></tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  return { subject, html };
}

module.exports = { buildEditorEmail };
