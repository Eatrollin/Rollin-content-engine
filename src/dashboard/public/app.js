/* ─── State ─────────────────────────────────────────────────────────────────── */
let STATE      = null;
let TODAY      = null;
let rejectTarget = null;  // { recId, tier, title }

/* ─── Init ──────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());
  document.getElementById('nav-date').textContent = TODAY;
  loadState();
  loadDateDropdown();

  // Socket.io — live updates when pipeline completes or approval changes
  const socket = io();
  socket.on('pipeline:complete', () => {
    setStatus('done');
    showToast('Pipeline complete — refreshing data…', 'ok');
    setTimeout(loadState, 1200);
  });
  socket.on('approval:update', (data) => {
    updateCardDecision(data.recId, data.decision);
    updateApprovalCounter();
  });
  socket.on('pipeline:start', () => setStatus('running'));
  socket.on('pipeline:error', () => setStatus('error'));
});

/* ─── Rec Detail Modal ──────────────────────────────────────────────────────── */
async function openRecDetail(recId, date) {
  try {
    const d   = date || TODAY;
    const res = await fetch(`/api/recommendation/${recId}?date=${d}`);
    if (!res.ok) { showToast('Could not load recommendation details', 'err'); return; }
    const rec = await res.json();
    showRecDetailModal(rec);
  } catch (err) {
    showToast('Failed to load details: ' + err.message, 'err');
  }
}

function closeRecDetail() {
  const el = document.getElementById('rec-detail-modal');
  if (el) el.remove();
}

function showRecDetailModal(rec) {
  const existing = document.getElementById('rec-detail-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'rec-detail-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = buildRecDetailHTML(rec);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) closeRecDetail(); });
}

function buildRecDetailHTML(rec) {
  const tier     = rec.tier || 'low';
  const label    = rec.label === 'AI-FLAGGED' ? 'AI-FLAGGED' : 'KPI-CONFIRMED';
  const labelCls = label === 'AI-FLAGGED' ? 'label-ai' : 'label-kpi';
  const brief    = rec.contentBrief    || {};
  const hf       = rec.higgsfieldBrief || {};
  const fm       = rec.footageMatch    || { type: 'pending' };

  const scriptHtml = (brief.scriptOutline || []).map(l =>
    `<div class="detail-script-beat">${escHtml(l)}</div>`
  ).join('');

  const tagsHtml = (brief.hashtagSet || []).map(t =>
    `<span class="brief-tag">#${t}</span>`
  ).join('');

  let footageHtml = '';
  if (fm.type === 'seedance-ready') {
    const filesHtml = (fm.matchedFiles || []).map(f =>
      `<div class="detail-file-item">▸ ${escHtml(f)}</div>`
    ).join('');
    footageHtml = `
      <div class="detail-match-badge detail-match-seedance">SEEDANCE-READY</div>
      ${filesHtml ? `<div class="detail-sub-label">MATCHED FILES</div><div class="detail-file-list">${filesHtml}</div>` : ''}
      <div class="detail-sub-label">SEEDANCE PROMPT</div>
      <div class="detail-copybox" data-copy="${escAttr(fm.seedancePrompt)}" onclick="copyBoxClick(this)">${escHtml(fm.seedancePrompt || '')}<span class="detail-copy-hint">CLICK TO COPY</span></div>`;
  } else if (fm.type === 'needs-shoot') {
    const shotsHtml = (fm.shotList || []).map(s =>
      `<div class="detail-shot-item">▸ ${escHtml(s)}</div>`
    ).join('');
    const hfText = [
      hf.sceneDescription ? `Scene: ${hf.sceneDescription}` : '',
      hf.styleDirection   ? `Style: ${hf.styleDirection}`   : '',
      hf.mood             ? `Mood: ${hf.mood}`               : '',
      hf.durationSeconds  ? `Duration: ${hf.durationSeconds}s` : '',
      hf.audioDirection   ? `Audio: ${hf.audioDirection}`   : '',
    ].filter(Boolean).join('\n');
    footageHtml = `
      <div class="detail-match-badge detail-match-shoot">NEEDS SHOOT</div>
      ${shotsHtml ? `<div class="detail-sub-label">SHOT LIST</div><div class="detail-shot-list">${shotsHtml}</div>` : ''}
      ${fm.shootDirections ? `<div class="detail-sub-label">SHOOT DIRECTIONS</div><div class="detail-body-text">${escHtml(fm.shootDirections)}</div>` : ''}
      <div class="detail-sub-label">HIGGSFIELD PROMPT</div>
      <div class="detail-copybox" data-copy="${escAttr(hfText)}" onclick="copyBoxClick(this)">${escHtml(hfText)}<span class="detail-copy-hint">CLICK TO COPY</span></div>`;
  } else {
    footageHtml = `<div class="detail-pending-note">Run pipeline to generate footage match</div>`;
  }

  return `
<div class="rec-detail-panel">
  <div class="detail-header">
    <div class="detail-header-meta">
      <span class="rank-badge">#${rec.rank || '?'}</span>
      <span class="tier-badge tier-${tier}">${tier.toUpperCase()}</span>
      <span class="label-badge ${labelCls}">${label}</span>
      <span class="confidence">${rec.confidenceScore}/10</span>
    </div>
    <button class="detail-close" onclick="closeRecDetail()">✕</button>
  </div>
  <div class="detail-title">${escHtml(rec.title || '')}</div>
  <div class="detail-body">

    <div class="detail-section">
      <div class="detail-section-label">TREND SUMMARY</div>
      <div class="detail-body-text">${escHtml(rec.trendSummary || '')}</div>
    </div>

    <div class="detail-section">
      <div class="detail-section-label">CONTENT BRIEF</div>
      ${brief.hook ? `<div class="detail-row"><span class="detail-label">HOOK</span><span class="detail-value">${escHtml(brief.hook)}</span></div>` : ''}
      ${scriptHtml ? `<div class="detail-row"><span class="detail-label">SCRIPT</span><div class="detail-value">${scriptHtml}</div></div>` : ''}
      ${brief.captionDirection ? `<div class="detail-row"><span class="detail-label">CAPTION DIR</span><span class="detail-value">${escHtml(brief.captionDirection)}</span></div>` : ''}
      ${brief.sampleCaption ? `<div class="detail-row"><span class="detail-label">CAPTION</span><span class="detail-value detail-italic">"${escHtml(brief.sampleCaption)}"</span></div>` : ''}
      ${tagsHtml ? `<div class="detail-row"><span class="detail-label">TAGS</span><div class="detail-value brief-tags">${tagsHtml}</div></div>` : ''}
      ${brief.callToAction ? `<div class="detail-row"><span class="detail-label">CTA</span><span class="detail-value">${escHtml(brief.callToAction)}</span></div>` : ''}
    </div>

    ${rec.rawFootageNote ? `
    <div class="detail-section">
      <div class="detail-section-label">RAW FOOTAGE NOTE</div>
      <div class="detail-body-text">${escHtml(rec.rawFootageNote)}</div>
    </div>` : ''}

    ${(hf.sceneDescription || hf.styleDirection) ? `
    <div class="detail-section">
      <div class="detail-section-label">HIGGSFIELD BRIEF</div>
      ${hf.sceneDescription ? `<div class="detail-row"><span class="detail-label">SCENE</span><span class="detail-value">${escHtml(hf.sceneDescription)}</span></div>` : ''}
      ${hf.styleDirection   ? `<div class="detail-row"><span class="detail-label">STYLE</span><span class="detail-value">${escHtml(hf.styleDirection)}</span></div>`   : ''}
      ${hf.mood             ? `<div class="detail-row"><span class="detail-label">MOOD</span><span class="detail-value">${escHtml(hf.mood)}</span></div>`             : ''}
      ${hf.durationSeconds  ? `<div class="detail-row"><span class="detail-label">DURATION</span><span class="detail-value">${hf.durationSeconds}s</span></div>`   : ''}
      ${hf.audioDirection   ? `<div class="detail-row"><span class="detail-label">AUDIO</span><span class="detail-value">${escHtml(hf.audioDirection)}</span></div>` : ''}
    </div>` : ''}

    ${rec.higgsfieldPrompt ? `
    <div class="detail-section">
      <div class="detail-section-label">HIGGSFIELD PROMPT — COPY &amp; PASTE</div>
      <div class="detail-copybox" data-copy="${escAttr(rec.higgsfieldPrompt.copyablePrompt)}" onclick="copyBoxClick(this)">${escHtml(rec.higgsfieldPrompt.copyablePrompt || '')}<span class="detail-copy-hint">CLICK TO COPY</span></div>
      <button class="copy-btn" data-copy="${escAttr(rec.higgsfieldPrompt.copyablePrompt)}" onclick="copyBtnClick(this, this.dataset.copy)">COPY PROMPT</button>
    </div>` : ''}

    ${rec.whyItWillWork ? `
    <div class="detail-section">
      <div class="detail-section-label">WHY IT WILL WORK</div>
      <div class="detail-body-text">${escHtml(rec.whyItWillWork)}</div>
    </div>` : ''}

    ${rec.productionPackage ? `
    <div class="detail-section">
      <div class="detail-section-label">PRODUCTION PACKAGE</div>
      <div class="detail-row"><span class="detail-label">CLIPS</span><span class="detail-value">${rec.productionPackage.totalClipsToShoot || '—'} clips</span></div>
      <div class="detail-row"><span class="detail-label">SHOOT TIME</span><span class="detail-value">${escHtml(rec.productionPackage.estimatedShootTime || '—')}</span></div>
      <div class="detail-row"><span class="detail-label">FINAL LENGTH</span><span class="detail-value">${escHtml(rec.productionPackage.finalVideoDuration || '—')}</span></div>
      ${rec.productionPackage.musicAndAudioPlan ? `<div class="detail-row"><span class="detail-label">AUDIO PLAN</span><span class="detail-value">${escHtml(rec.productionPackage.musicAndAudioPlan)}</span></div>` : ''}
    </div>` : ''}

    ${(rec.productionPackage && rec.productionPackage.shootList) ? `
    <div class="detail-section">
      <div class="detail-section-label">SHOOT LIST — FILM IN THIS ORDER</div>
      <div class="detail-body-text" style="color:#888;font-size:11px;margin-bottom:10px;">This is the order to physically film clips. The edit order below is different.</div>
      ${rec.productionPackage.shootList.map(c => `
        <div class="shoot-clip" style="border:1px solid #2a2a2a;padding:10px;margin-bottom:8px;border-radius:4px;">
          <div style="font-weight:600;color:#d4a55a;margin-bottom:6px;">CLIP ${c.clipNumber} — ${escHtml(c.subject || '')}</div>
          <div style="font-size:12px;color:#aaa;line-height:1.6;">
            <div><span style="color:#666;">Angle:</span> ${escHtml(c.cameraAngle || '—')}</div>
            <div><span style="color:#666;">Distance:</span> ${escHtml(c.shotDistance || '—')}</div>
            <div><span style="color:#666;">Movement:</span> ${escHtml(c.cameraMovement || '—')}</div>
            <div><span style="color:#666;">Record:</span> ${escHtml(c.recordDuration || '—')}</div>
            <div><span style="color:#666;">Lighting:</span> ${escHtml(c.lighting || '—')}</div>
            <div><span style="color:#666;">Critical:</span> <span style="color:#e8c98a;">${escHtml(c.criticalDetail || '—')}</span></div>
          </div>
        </div>
      `).join('')}
    </div>` : ''}

    ${(rec.productionPackage && rec.productionPackage.editOrder) ? `
    <div class="detail-section">
      <div class="detail-section-label">EDIT ORDER — CAPCUT TIMELINE</div>
      <div class="detail-body-text" style="color:#888;font-size:11px;margin-bottom:10px;">Build the CapCut timeline in this order. Each slot tells you which Shoot Clip to drop in.</div>
      ${rec.productionPackage.editOrder.map(s => `
        <div class="edit-slot" style="border-left:3px solid #d4a55a;padding:8px 12px;margin-bottom:8px;background:#1a1a1a;">
          <div style="font-weight:600;color:#fff;margin-bottom:4px;">${escHtml(s.timestamp || '')} — Use ${escHtml(s.shootClipRef || '')}</div>
          <div style="font-size:12px;color:#aaa;line-height:1.6;">
            <div><span style="color:#666;">Final length:</span> ${escHtml(s.finalDuration || '—')}</div>
            <div><span style="color:#666;">Transition:</span> ${escHtml(s.transitionIn || '—')}</div>
            ${s.onScreenText ? `<div><span style="color:#666;">Text overlay:</span> <span style="color:#e8c98a;">"${escHtml(s.onScreenText)}"</span></div>` : ''}
            ${s.audioCue ? `<div><span style="color:#666;">Audio cue:</span> ${escHtml(s.audioCue)}</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>` : ''}

    <div class="detail-section">
      <div class="detail-section-label">STYLE FEEDBACK — TEACH THE PIPELINE</div>
      <div class="detail-body-text" style="color:#888;font-size:11px;margin-bottom:10px;">After you build this in CapCut, tell the pipeline what worked or didn't work about the production package style.</div>
      <textarea id="style-reason-${rec.id}" placeholder="Reason (e.g. 'Loved the shoot order — made plating logical' or 'Edit order had too many quick cuts')" class="approve-note-input" style="width:100%;font-size:13px;padding:10px;min-height:60px;resize:vertical;margin-bottom:8px;"></textarea>
      <div style="display:flex;gap:8px;">
        <button class="btn-approve" style="flex:1;padding:10px;" onclick="submitStyleFeedback('${rec.id}','${escAttr(rec.title || '')}','positive')">+ STYLE</button>
        <button class="btn-reject" style="flex:1;padding:10px;" onclick="submitStyleFeedback('${rec.id}','${escAttr(rec.title || '')}','negative')">− STYLE</button>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-label">FOOTAGE MATCH</div>
      ${footageHtml}
    </div>

  </div>
</div>`;
}

function copyBoxClick(el) {
  const text = el.getAttribute('data-copy') || '';
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard', 'ok')).catch(() => showToast('Copy failed', 'err'));
}

function copyBtnClick(btn, text) {
  navigator.clipboard.writeText(text)
    .then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'COPY PROMPT'; btn.classList.remove('copied'); }, 2000);
    })
    .catch(() => showToast('Copy failed', 'err'));
}

/* ─── Load state from API ───────────────────────────────────────────────────── */
async function loadState() {
  try {
    const res  = await fetch(`/api/state?date=${TODAY}`);
    STATE      = await res.json();
    renderAll(STATE);
  } catch (err) {
    console.error('Failed to load state:', err);
    showToast('Could not load data — is the server running?', 'err');
  }
}

async function loadDateDropdown() {
  try {
    const res   = await fetch('/api/dates');
    const data  = await res.json();
    const dates = data.dates || [];
    if (dates.length <= 1) return; // no dropdown needed if only one date

    // Build dropdown
    const nav = document.querySelector('.nav-meta');
    if (!nav) return;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;';

    const label = document.createElement('span');
    label.textContent = 'DATE:';
    label.style.cssText = 'color:#555;font-size:10px;letter-spacing:.1em;';

    const select = document.createElement('select');
    select.id = 'date-select';
    select.style.cssText = 'background:#111;color:#c8a96e;border:1px solid #333;padding:4px 8px;font-size:11px;letter-spacing:.05em;cursor:pointer;outline:none;';

    dates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      select.appendChild(opt);
    });

    // Snap TODAY to most recent date with data if current date has no data
    if (!dates.includes(TODAY)) {
      TODAY = dates[0]; // dates are sorted newest-first
      document.getElementById('nav-date').textContent = TODAY;
    }

    // Set dropdown to match TODAY
    select.value = TODAY;

    select.addEventListener('change', () => {
      TODAY = select.value;
      document.getElementById('nav-date').textContent = TODAY;
      loadState();
    });

    wrapper.appendChild(label);
    wrapper.appendChild(select);
    nav.insertBefore(wrapper, nav.firstChild);
  } catch (err) {
    console.error('Failed to load dates:', err);
  }
}

function renderAll(s) {
  renderMetrics(s.metrics);
  renderKpiVideos(s.kpiVideos || []);
  renderRecs(s.recommendations || []);
  renderHighgsfield(s.higgsfieldJobs || []);
  renderHistory(s.history || []);
}

/* ─── Metrics ───────────────────────────────────────────────────────────────── */
function renderMetrics(m) {
  if (!m) return;
  set('m-scraped', fmt(m.totalScraped));
  set('m-scraped-sub', `TikTok ${fmt(m.tiktokCount)} · IG ${fmt(m.instagramCount)}`);
  set('m-passed', fmt(m.passedKpi));

  // Day over day
  const dod = m.dayOverDayPct;
  const dodEl = document.getElementById('m-dod');
  if (dod === null || dod === undefined) {
    dodEl.textContent = '—';
    dodEl.className = 'metric-value';
  } else {
    const sign = dod > 0 ? '+' : '';
    dodEl.textContent = sign + dod + '%';
    dodEl.className = 'metric-value ' + (dod > 0 ? 'metric-up' : dod < 0 ? 'metric-down' : 'metric-flat');
  }
  set('m-dod-sub', 'vs yesterday avg KPI');

  const kws = m.topKeywords3 || ['—'];
  set('m-keywords', kws.join('  '));
}

/* ─── KPI Videos ────────────────────────────────────────────────────────────── */
function renderKpiVideos(videos) {
  const el    = document.getElementById('kpi-videos-list');
  const empty = document.getElementById('kpi-videos-empty');
  const count = document.getElementById('kpi-videos-count');
  if (!el) return;

  if (count) count.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;

  if (!videos.length) {
    el.style.display = 'none';
    if (empty) empty.style.display = '';
    return;
  }

  el.style.display = '';
  if (empty) empty.style.display = 'none';

  el.innerHTML = videos.map(v => {
    const score      = (v.compositeScore * 1000).toFixed(2);
    const signals    = (v.kpiSignalsMatched || []).map(s => `<span class="kpi-signal">${escHtml(s)}</span>`).join('');
    const caption    = (v.caption || '').slice(0, 220);
    const platform   = (v.platform || '').toUpperCase();
    const platCls    = v.platform === 'tiktok' ? 'kpi-plat-tiktok' : 'kpi-plat-ig';
    const views      = fmtK(v.viewCount || 0);
    const url        = escHtml(v.url || '#');
    const handle     = escHtml(v.accountHandle || '');

    return `
<div class="kpi-video-row">
  <div class="kpi-video-left">
    <span class="kpi-platform ${platCls}">${platform}</span>
    <a class="kpi-handle" href="${url}" target="_blank" rel="noopener">@${handle}</a>
  </div>
  <div class="kpi-video-center">
    ${caption ? `<div class="kpi-caption">${escHtml(caption)}</div>` : ''}
    ${signals ? `<div class="kpi-signals">${signals}</div>` : ''}
  </div>
  <div class="kpi-video-right">
    <div class="kpi-score">${score}<span class="kpi-score-unit">k</span></div>
    <div class="kpi-views">${views} views</div>
    <a class="kpi-link" href="${url}" target="_blank" rel="noopener">↗ OPEN</a>
  </div>
</div>`;
  }).join('');
}

/* ─── Recommendations ───────────────────────────────────────────────────────── */
function renderRecs(recs) {
  const containers = { high: 'recs-high', medium: 'recs-medium', low: 'recs-low' };
  Object.values(containers).forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });

  if (!recs.length) {
    document.getElementById('recs-empty').style.display = '';
    ['tier-high', 'tier-medium', 'tier-low'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    set('recs-count', '0 / 12');
    return;
  }

  document.getElementById('recs-empty').style.display = 'none';
  set('recs-count', `${recs.length} / 12`);

  // Show/hide tier sections
  const tierMap = { high: false, medium: false, low: false };
  recs.forEach(r => { tierMap[r.tier || 'low'] = true; });
  Object.entries(tierMap).forEach(([tier, hasRecs]) => {
    const el = document.getElementById('tier-' + tier);
    if (el) el.style.display = hasRecs ? '' : 'none';
  });

  recs.forEach(rec => {
    const tier = rec.tier || 'low';
    const container = document.getElementById('recs-' + tier);
    if (!container) return;
    container.insertAdjacentHTML('beforeend', buildRecCard(rec));
  });
}

function buildRecCard(rec) {
  const tier    = rec.tier || 'low';
  const label   = rec.label === 'AI-FLAGGED' ? 'AI-FLAGGED' : 'KPI-CONFIRMED';
  const labelCls = label === 'AI-FLAGGED' ? 'label-ai' : 'label-kpi';
  const conf    = rec.confidenceScore || 0;
  const brief   = rec.contentBrief || {};
  const tags    = (brief.hashtagSet || []).slice(0, 6).map(t => `<span class="brief-tag">#${t}</span>`).join('');
  const isApproved = rec.approved  || rec.approvalStatus === 'approved';
  const isRejected = rec.rejected  || rec.approvalStatus === 'rejected';
  const cardCls    = isApproved ? 'is-approved' : isRejected ? 'is-rejected' : '';
  const hook    = (brief.hook || '').slice(0, 120);
  const caption = (brief.sampleCaption || '').slice(0, 100);

  const seriesBadge = rec.seriesPotential
    ? `<span class="badge badge-series">SERIES POTENTIAL</span>`
    : '';

  const approvalNote = rec.approvalNote ? ` — ${escHtml(rec.approvalNote.slice(0, 80))}` : '';
  const actionHtml = isApproved
    ? `<div class="decision-label decision-approved">✓ APPROVED${approvalNote}</div>`
    : isRejected
    ? `<div class="decision-label decision-rejected">✗ REJECTED — ${escHtml(rec.rejectionNote || '').slice(0, 60)}</div>`
    : `<div class="rec-footer" onclick="event.stopPropagation()">
         <input type="text" id="approve-note-${rec.id}" class="approve-note-input" placeholder="Why are you approving this? (optional)" />
         <div class="rec-footer-actions">
           <button class="btn-approve" onclick="handleApprove('${rec.id}','${tier}')">APPROVE</button>
           <button class="btn-reject"  onclick="openRejectModal('${rec.id}','${tier}','${escAttr(rec.title)}')">REJECT</button>
           <button class="btn-series"  onclick="startSeries('${rec.id}','${tier}',event)">SERIES +</button>
         </div>
       </div>`;

  return `
<div class="rec-card ${cardCls}" id="card-${rec.id}" onclick="openRecDetail('${rec.id}')">
  <div class="rec-header">
    <span class="rank-badge">#${rec.rank || '?'}</span>
    <span class="tier-badge tier-${tier}">${tier.toUpperCase()}</span>
    <span class="label-badge ${labelCls}">${label}</span>
    <span class="confidence">${conf}/10</span>
    ${seriesBadge}
  </div>
  <div class="rec-title">${escHtml(rec.title || '')}</div>
  <div class="rec-trend">${escHtml((rec.trendSummary || '').slice(0, 200))}</div>
  <div class="rec-brief">
    ${hook ? `<div class="brief-row"><span class="brief-label">HOOK</span><span class="brief-value">${escHtml(hook)}</span></div>` : ''}
    ${caption ? `<div class="brief-row"><span class="brief-label">CAPTION</span><span class="brief-value brief-caption">"${escHtml(caption)}"</span></div>` : ''}
    ${tags ? `<div class="brief-row"><span class="brief-label">TAGS</span><span class="brief-value brief-tags">${tags}</span></div>` : ''}
  </div>
  ${actionHtml}
</div>`;
}

/* ─── Approve / Reject ──────────────────────────────────────────────────────── */
async function handleApprove(recId, tier) {
  const card    = document.getElementById('card-' + recId);
  if (!card) return;
  const noteEl  = document.getElementById('approve-note-' + recId);
  const note    = noteEl ? noteEl.value.trim() : '';

  try {
    const res  = await fetch('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recId, date: TODAY, tier, note }) });
    const data = await res.json();
    if (data.success) {
      updateCardDecision(recId, 'approved');
      showToast(`Approved — ${data.remaining} slots remaining today`, 'ok');
      updateApprovalCounter();
    } else {
      showToast(data.error || 'Could not approve', 'err');
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'err');
  }
}

function openRejectModal(recId, tier, title) {
  rejectTarget = { recId, tier };
  document.getElementById('modal-rec-title').textContent = title;
  document.getElementById('reject-note').value = '';
  document.getElementById('reject-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('reject-modal').style.display = 'none';
  rejectTarget = null;
}

async function confirmReject() {
  if (!rejectTarget) return;
  const note = document.getElementById('reject-note').value.trim();
  const { recId, tier } = rejectTarget;
  closeModal();

  try {
    const res  = await fetch('/api/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recId, date: TODAY, tier, note }) });
    const data = await res.json();
    if (data.success) {
      updateCardDecision(recId, 'rejected', note);
      showToast('Rejected — pattern logged for learning', 'ok');
    } else {
      showToast(data.error || 'Could not reject', 'err');
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'err');
  }
}

function updateCardDecision(recId, decision, note) {
  const card = document.getElementById('card-' + recId);
  if (!card) return;
  card.classList.remove('is-approved', 'is-rejected');
  card.classList.add(decision === 'approved' ? 'is-approved' : 'is-rejected');

  const footer = card.querySelector('.rec-footer');
  const existing = card.querySelector('.decision-label');
  if (existing) existing.remove();

  const label = document.createElement('div');
  label.className = 'decision-label ' + (decision === 'approved' ? 'decision-approved' : 'decision-rejected');
  label.textContent = decision === 'approved'
    ? `✓ APPROVED${note ? ' — ' + note.slice(0, 80) : ''}`
    : `✗ REJECTED${note ? ' — ' + note.slice(0, 60) : ''}`;

  if (footer) footer.replaceWith(label);
  else card.appendChild(label);
}

function updateApprovalCounter() {
  if (!STATE) return;
  fetch(`/api/state?date=${TODAY}`)
    .then(r => r.json())
    .then(s => { if (s.metrics) renderMetrics(s.metrics); })
    .catch(() => {});
}

/* ─── Higgsfield ────────────────────────────────────────────────────────────── */
function renderHighgsfield(jobs) {
  const el = document.getElementById('higgsfield-jobs');
  const empty = document.getElementById('higgsfield-empty');
  if (!el) return;

  if (!jobs.length) {
    el.style.display = 'none';
    if (empty) empty.style.display = '';
    return;
  }

  el.style.display = '';
  if (empty) empty.style.display = 'none';
  el.innerHTML = jobs.map(buildHFCard).join('');
}

function buildHFCard(job) {
  const statusCls = {
    pending:    'hf-status-pending',
    processing: 'hf-status-processing',
    completed:  'hf-status-completed',
    failed:     'hf-status-failed',
  }[job.status] || 'hf-status-pending';

  const linkHtml = job.renderLink
    ? `<a class="hf-link" href="${escHtml(job.renderLink)}" target="_blank">↗ VIEW RENDER</a>`
    : '';
  const pollBtn = !job.renderLink && job.jobId
    ? `<button class="btn-poll" onclick="pollHFJob('${job.jobId}','${job.recId}')">↻ CHECK STATUS</button>`
    : '';

  return `
<div class="hf-card" id="hf-${job.recId}">
  <div class="hf-header">
    <div class="hf-title">${escHtml(job.title || 'Untitled')}</div>
    <span class="hf-status ${statusCls}">${(job.status || 'pending').toUpperCase()}</span>
  </div>
  <div class="hf-meta">Submitted: ${job.submittedAt ? new Date(job.submittedAt).toLocaleString() : '—'}</div>
  ${job.footageUsed ? `<div class="hf-meta">Footage: ${escHtml(job.footageUsed)}</div>` : ''}
  <div class="hf-job-id">Job ID: ${escHtml(job.jobId || 'pending')}</div>
  ${linkHtml}${pollBtn}
</div>`;
}

async function pollHFJob(jobId, recId) {
  try {
    const res  = await fetch(`/api/higgsfield/${jobId}`);
    const data = await res.json();
    const card = document.getElementById('hf-' + recId);
    if (!card) return;

    const statusEl = card.querySelector('.hf-status');
    if (statusEl) {
      const cls = { pending:'hf-status-pending', processing:'hf-status-processing', completed:'hf-status-completed', failed:'hf-status-failed' }[data.status] || 'hf-status-pending';
      statusEl.className = 'hf-status ' + cls;
      statusEl.textContent = (data.status || 'unknown').toUpperCase();
    }

    if (data.renderLink) {
      const pollBtn = card.querySelector('.btn-poll');
      if (pollBtn) pollBtn.insertAdjacentHTML('afterend', `<a class="hf-link" href="${escHtml(data.renderLink)}" target="_blank">↗ VIEW RENDER</a>`);
      if (pollBtn) pollBtn.remove();
      showToast('Render ready — click to view!', 'ok');
    } else {
      showToast(`Status: ${data.status || 'unknown'}`, 'ok');
    }
  } catch (err) {
    showToast('Status check failed: ' + err.message, 'err');
  }
}

/* ─── History ───────────────────────────────────────────────────────────────── */
function renderHistory(posts) {
  const el    = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  if (!el) return;

  if (!posts.length) {
    el.style.display = 'none';
    if (empty) empty.style.display = '';
    return;
  }

  el.style.display = '';
  if (empty) empty.style.display = 'none';
  el.innerHTML = posts.map(p => `
<div class="hist-row">
  <span class="hist-platform">${(p.platform || '').toUpperCase()}</span>
  <span class="hist-caption">${escHtml(p.caption || '—')}</span>
  <span class="hist-kpi">${p.kpi72h ? (p.kpi72h * 1000).toFixed(2) + 'k' : '—'}</span>
  <span class="hist-views">${p.views72h ? fmtK(p.views72h) : '—'}</span>
  <span class="hist-badge ${p.wasApproved ? 'hist-approved' : 'hist-organic'}">${p.wasApproved ? 'APPROVED' : 'ORGANIC'}</span>
</div>`).join('');
}

/* ─── Custom Series Modal ───────────────────────────────────────────────────── */
function openCreateSeriesModal() {
  const existing = document.getElementById('create-series-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'create-series-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
<div class="rec-detail-panel" style="max-width:520px">
  <div class="detail-header">
    <div class="detail-header-meta"><span class="tier-badge tier-high">NEW SERIES</span></div>
    <button class="detail-close" onclick="closeCreateSeriesModal()">✕</button>
  </div>
  <div class="detail-title">Create Custom Series</div>
  <div class="detail-body">
    <div class="detail-section">
      <div class="detail-section-label">SERIES NAME</div>
      <input id="new-series-name" type="text" placeholder="e.g. Chopping" class="approve-note-input" style="width:100%;font-size:14px;padding:10px;" />
    </div>
    <div class="detail-section">
      <div class="detail-section-label">SERIES DESCRIPTION</div>
      <textarea id="new-series-desc" placeholder="e.g. Chef Ivan showing off knife skills — julienne, brunoise, breaking down proteins, speed cuts. Dark cinematic style. Each episode isolates one technique." class="approve-note-input" style="width:100%;font-size:13px;padding:10px;min-height:120px;resize:vertical;"></textarea>
    </div>
    <div class="detail-section">
      <div class="detail-body-text" style="color:#888;font-size:11px;">Each pipeline run will take what is trending on social media and apply it creatively to your series concept to generate the next episode.</div>
    </div>
    <div style="display:flex;gap:10px;margin-top:8px;">
      <button class="btn-approve" style="flex:1;padding:12px;" onclick="submitCreateSeries()">CREATE SERIES</button>
      <button class="btn-reject" style="flex:1;padding:12px;" onclick="closeCreateSeriesModal()">CANCEL</button>
    </div>
  </div>
</div>`;

  overlay.addEventListener('click', e => { if (e.target === overlay) closeCreateSeriesModal(); });
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('new-series-name')?.focus(), 100);
}

function closeCreateSeriesModal() {
  const el = document.getElementById('create-series-modal');
  if (el) el.remove();
}

async function submitCreateSeries() {
  const name = document.getElementById('new-series-name')?.value.trim();
  const desc = document.getElementById('new-series-desc')?.value.trim();
  if (!name) { showToast('Please enter a series name', 'err'); return; }
  if (!desc) { showToast('Please enter a series description', 'err'); return; }
  try {
    const res  = await fetch('/api/series/create-custom', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, description: desc }),
    });
    const data = await res.json();
    if (data.success) {
      closeCreateSeriesModal();
      showToast(`"${name}" series created — episodes generate on next pipeline run`, 'ok');
      loadSeries();
    } else {
      showToast(data.error || 'Could not create series', 'err');
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'err');
  }
}

/* ─── Tabs ──────────────────────────────────────────────────────────────────── */
function switchTab(tab) {
  document.getElementById('tab-main').style.display   = tab === 'main'   ? '' : 'none';
  document.getElementById('tab-series').style.display = tab === 'series' ? '' : 'none';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
  document.querySelector(`[onclick="switchTab('${tab}')"]`).classList.add('tab-active');
  if (tab === 'series') loadSeries();
}

/* ─── Series ─────────────────────────────────────────────────────────────────── */
async function startSeries(recId, tier, e) {
  e.stopPropagation();
  try {
    const res  = await fetch('/api/series/create', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ recId, date: TODAY, tier }),
    });
    const data = await res.json();
    if (data.success) showToast('Series started! Check the Series tab.', 'ok');
    else showToast(data.error || 'Could not start series', 'err');
  } catch (err) {
    showToast('Network error: ' + err.message, 'err');
  }
}

async function loadSeries() {
  try {
    const res  = await fetch('/api/series');
    const data = await res.json();
    renderSeries(data.series || []);
  } catch (err) {
    showToast('Failed to load series: ' + err.message, 'err');
  }
}

function renderSeries(series) {
  const el    = document.getElementById('series-list');
  const empty = document.getElementById('series-empty');
  const count = document.getElementById('series-count');
  if (!el) return;

  const active = series.filter(s => s.status === 'active');
  if (count) count.textContent = `${active.length} series`;

  if (!active.length) {
    el.style.display = 'none';
    if (empty) {
      empty.innerHTML = '<div style="margin-bottom:16px;"><button class="btn-approve" style="padding:10px 24px;letter-spacing:.1em;" onclick="openCreateSeriesModal()">+ CREATE SERIES</button></div><div style="color:#555;">No active series yet. Create one above or use SERIES + on any recommendation.</div>';
      empty.style.display = '';
    }
    return;
  }

  el.style.display = '';
  if (empty) empty.style.display = 'none';
  el.innerHTML = `<div style="margin-bottom:16px;"><button class="btn-approve" style="padding:10px 24px;letter-spacing:.1em;" onclick="openCreateSeriesModal()">+ CREATE SERIES</button></div>` + active.map(s => buildSeriesCard(s)).join('');
}

function buildSeriesCard(s) {
  const episodesHtml = (s.episodes || []).map(ep => {
    const statusLabel = ep.approved ? '✓ APPROVED' : ep.rejected ? '✗ REJECTED' : 'PENDING';
    const scoreHtml   = ep.performanceScore !== null && ep.performanceScore !== undefined
      ? `<div class="series-ep-score">Score: ${(ep.performanceScore * 1000).toFixed(2)}k</div>`
      : '';
    const actionsHtml = !ep.approved && !ep.rejected ? `
      <div class="series-ep-actions" onclick="event.stopPropagation()">
        <input type="text" id="ep-note-${ep.id}" placeholder="Note (optional)" class="approve-note-input" />
        <button class="btn-approve" onclick="approveSeriesEpisode('${s.id}','${ep.id}')">APPROVE</button>
        <button class="btn-reject"  onclick="rejectSeriesEpisode('${s.id}','${ep.id}')">REJECT</button>
      </div>` : '';
    const briefLink = ep.recId
      ? `<div class="series-ep-brief-link" onclick="event.stopPropagation();openRecDetail('${ep.recId}','${ep.date || ''}')">VIEW FULL BRIEF →</div>`
      : '';
    const clickAttr = ep.recId
      ? `style="cursor:pointer" onclick="openRecDetail('${ep.recId}','${ep.date || ''}')"` : '';
    return `
<div class="series-episode" id="ep-${ep.id}" ${clickAttr}>
  <div class="series-ep-title">${escHtml(ep.title || '')}</div>
  <div class="series-ep-meta">${ep.date || ''}  <span class="series-ep-status">${statusLabel}</span>${ep.note ? ` — ${escHtml(ep.note)}` : ''}</div>
  ${scoreHtml}
  ${actionsHtml}
  ${briefLink}
</div>`;
  }).join('');

  return `
<div class="series-card">
  <div class="series-card-header">
    <div class="series-name">${escHtml(s.name || '')} ${s.type === 'custom' ? '<span class="badge badge-series" style="font-size:9px;margin-left:6px;">CUSTOM</span>' : '<span style="font-size:9px;color:#555;margin-left:6px;letter-spacing:.05em;">AUTO</span>'}</div>
    <div class="series-meta">Started: ${s.seedDate || '—'}  ·  ${(s.episodes || []).length} episode(s) &nbsp;<button class="btn-delete-series" onclick="event.stopPropagation();confirmDeleteSeries('${s.id}','${escAttr(s.name)}')">DELETE</button></div>
  </div>
  <div class="series-episodes">${episodesHtml || '<div class="series-no-ep">No episodes yet — run the pipeline to generate</div>'}</div>
</div>`;
}

async function approveSeriesEpisode(seriesId, episodeId) {
  const note = document.getElementById(`ep-note-${episodeId}`)?.value || '';
  try {
    const res  = await fetch(`/api/series/${seriesId}/approve/${episodeId}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ note }),
    });
    const data = await res.json();
    if (data.success) { showToast('Episode approved', 'ok'); loadSeries(); }
    else showToast(data.error || 'Could not approve episode', 'err');
  } catch (err) {
    showToast('Network error: ' + err.message, 'err');
  }
}

async function rejectSeriesEpisode(seriesId, episodeId) {
  const note = document.getElementById(`ep-note-${episodeId}`)?.value || '';
  try {
    const res  = await fetch(`/api/series/${seriesId}/reject/${episodeId}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ note }),
    });
    const data = await res.json();
    if (data.success) { showToast('Episode rejected', 'ok'); loadSeries(); }
    else showToast(data.error || 'Could not reject episode', 'err');
  } catch (err) {
    showToast('Network error: ' + err.message, 'err');
  }
}

async function confirmDeleteSeries(seriesId, seriesName) {
  if (!confirm(`Delete "${seriesName}"? This cannot be undone.`)) return;
  try {
    const res  = await fetch(`/api/series/${seriesId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showToast('Series deleted', 'ok'); loadSeries(); }
    else showToast(data.error || 'Could not delete series', 'err');
  } catch (err) {
    showToast('Network error: ' + err.message, 'err');
  }
}

/* ─── Status indicator ──────────────────────────────────────────────────────── */
function setStatus(s) {
  const el = document.getElementById('pipeline-status');
  if (!el) return;
  const map = { idle: ['IDLE', 'status-idle'], running: ['RUNNING', 'status-running'], done: ['COMPLETE', 'status-done'], error: ['ERROR', 'status-error'] };
  const [text, cls] = map[s] || map.idle;
  el.textContent = text;
  el.className = 'status-badge ' + cls;
}

/* ─── Toast ─────────────────────────────────────────────────────────────────── */
let toastTimer;
function showToast(msg, type = 'ok') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'show toast-' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = el.className.replace(' show', ''); }, 3500);
}

/* ─── Utils ─────────────────────────────────────────────────────────────────── */
function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function fmt(n) { return n != null ? Number(n).toLocaleString() : '—'; }
function fmtK(n) { return n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s).replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

async function submitStyleFeedback(recId, recTitle, type) {
  const reason = document.getElementById(`style-reason-${recId}`)?.value.trim() || '';
  if (!reason) { showToast('Please add a reason so the pipeline can learn', 'err'); return; }
  try {
    const res  = await fetch('/api/style-feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ recId, recTitle, type, reason }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Style feedback recorded — pipeline will learn`, 'ok');
      const el = document.getElementById(`style-reason-${recId}`);
      if (el) el.value = '';
    } else {
      showToast(data.error || 'Could not record feedback', 'err');
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'err');
  }
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.id === 'reject-modal') closeModal();
});
