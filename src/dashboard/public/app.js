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
async function openRecDetail(recId) {
  try {
    const res = await fetch(`/api/recommendation/${recId}?date=${TODAY}`);
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
         </div>
       </div>`;

  return `
<div class="rec-card ${cardCls}" id="card-${rec.id}" onclick="openRecDetail('${rec.id}')">
  <div class="rec-header">
    <span class="rank-badge">#${rec.rank || '?'}</span>
    <span class="tier-badge tier-${tier}">${tier.toUpperCase()}</span>
    <span class="label-badge ${labelCls}">${label}</span>
    <span class="confidence">${conf}/10</span>
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

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.id === 'reject-modal') closeModal();
});
