/* ─── State ─────────────────────────────────────────────────────────────────── */
let STATE      = null;
let TODAY      = null;
let rejectTarget = null;  // { recId, tier, title }
let charts     = {};

/* ─── Init ──────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  TODAY = new Date().toISOString().slice(0, 10);
  document.getElementById('nav-date').textContent = TODAY;
  loadState();

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

function renderAll(s) {
  renderMetrics(s.metrics);
  renderCharts(s.charts);
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

  const kw = m.topKeyword || '—';
  set('m-keyword', '#' + kw);

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

  set('m-approvals', `${m.todayApprovals} / ${m.approvalCap}`);
  set('m-approvals-sub', m.todayApprovals >= m.approvalCap ? '⚠ CAP REACHED' : `${m.approvalCap - m.todayApprovals} remaining`);
}

/* ─── Charts ────────────────────────────────────────────────────────────────── */
const CHART_DEFAULTS = {
  plugins: { legend: { labels: { color: '#888', font: { size: 11 } } } },
  scales:  {},
};

function renderCharts(data) {
  if (!data) return;
  renderKpiChart(data.kpiDistribution);
  renderTierChart(data.tierClusters);
  render7DayChart(data.sevenDayPerf);
}

function renderKpiChart(dist) {
  const ctx = document.getElementById('chart-kpi');
  if (!ctx) return;
  if (charts.kpi) charts.kpi.destroy();
  charts.kpi = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(dist || {}),
      datasets: [{ label: 'Videos', data: Object.values(dist || {}), backgroundColor: '#c8a96e44', borderColor: '#c8a96e', borderWidth: 1 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#666', font: { size: 10 } }, grid: { color: '#1e1e1e' } },
        y: { ticks: { color: '#888', font: { size: 10 } }, grid: { color: '#1e1e1e' } },
      },
    },
  });
}

function renderTierChart(tiers) {
  const ctx = document.getElementById('chart-tiers');
  if (!ctx) return;
  if (charts.tier) charts.tier.destroy();
  const t = tiers || { high: 0, medium: 0, low: 0 };
  charts.tier = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['HIGH', 'MEDIUM', 'LOW'],
      datasets: [{ data: [t.high, t.medium, t.low], backgroundColor: ['#c8a96e44', '#9999aa33', '#55556633'], borderColor: ['#c8a96e', '#9999aa', '#555566'], borderWidth: 1 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#888', font: { size: 10 }, boxWidth: 10, padding: 10 } } },
    },
  });
}

function render7DayChart(days) {
  const ctx = document.getElementById('chart-7day');
  if (!ctx) return;
  if (charts.sevenDay) charts.sevenDay.destroy();
  const d = days || [];
  charts.sevenDay = new Chart(ctx, {
    type: 'line',
    data: {
      labels: d.map(x => x.date?.slice(5) || ''),
      datasets: [
        { label: 'Avg KPI', data: d.map(x => x.avgKpi ? +(x.avgKpi * 1000).toFixed(3) : null), borderColor: '#c8a96e', backgroundColor: '#c8a96e11', tension: 0.3, pointBackgroundColor: '#c8a96e', pointRadius: 4, spanGaps: true },
        { label: 'Posts',   data: d.map(x => x.postCount), borderColor: '#444466', backgroundColor: '#44446611', tension: 0.3, pointBackgroundColor: '#444466', pointRadius: 3, yAxisID: 'y2', spanGaps: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#888', font: { size: 10 }, boxWidth: 10 } } },
      scales: {
        x:  { ticks: { color: '#666', font: { size: 10 } }, grid: { color: '#1a1a1a' } },
        y:  { ticks: { color: '#888', font: { size: 10 } }, grid: { color: '#1a1a1a' }, title: { display: true, text: 'KPI ×1000', color: '#555', font: { size: 9 } } },
        y2: { position: 'right', ticks: { color: '#555', font: { size: 10 } }, grid: { display: false }, title: { display: true, text: 'Posts', color: '#444', font: { size: 9 } } },
      },
    },
  });
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
    : `<div class="rec-footer">
         <input type="text" id="approve-note-${rec.id}" class="approve-note-input" placeholder="Why are you approving this? (optional)" />
         <div class="rec-footer-actions">
           <button class="btn-approve" onclick="handleApprove('${rec.id}','${tier}')">APPROVE</button>
           <button class="btn-reject"  onclick="openRejectModal('${rec.id}','${tier}','${escAttr(rec.title)}')">REJECT</button>
         </div>
       </div>`;

  return `
<div class="rec-card ${cardCls}" id="card-${rec.id}">
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
