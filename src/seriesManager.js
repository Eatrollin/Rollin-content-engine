require('dotenv').config();

const path   = require('path');
const fse    = require('fs-extra');
const logger = require('./logger');
const { DATA_DIR } = require('./config');

const SERIES_FILE = path.join(DATA_DIR, 'series.json');

async function loadSeries() {
  try {
    return await fse.readJson(SERIES_FILE);
  } catch {
    return { series: [] };
  }
}

async function saveSeries(data) {
  await fse.ensureDir(path.dirname(SERIES_FILE));
  await fse.writeJson(SERIES_FILE, data, { spaces: 2 });
}

async function createSeries(rec, seriesName) {
  const data = await loadSeries();
  const id   = `series_${String(data.series.length + 1).padStart(3, '0')}`;
  const name = seriesName || `New Series — ${(rec.title || '').slice(0, 30)}`;

  const series = {
    id,
    name,
    createdAt:  new Date().toISOString(),
    seedRecId:  rec.id    || null,
    seedTitle:  rec.title || '',
    seedDate:   rec.date  || new Date().toISOString().slice(0, 10),
    status:     'active',
    episodes:   [
      {
        id:               'ep_001',
        recId:            rec.id    || null,
        title:            rec.title || '',
        date:             rec.date  || new Date().toISOString().slice(0, 10),
        approved:         false,
        rejected:         false,
        note:             '',
        postUrl:          null,
        performanceScore: null,
      },
    ],
  };

  data.series.push(series);
  await saveSeries(data);
  logger.info(`[SeriesManager] Created series "${name}" (${id}) from rec "${rec.title}"`);
  return series;
}

async function addEpisode(seriesId, rec) {
  const data   = await loadSeries();
  const series = data.series.find(s => s.id === seriesId);
  if (!series) {
    logger.warn(`[SeriesManager] Series ${seriesId} not found`);
    return null;
  }

  const epNum = String(series.episodes.length + 1).padStart(3, '0');
  const ep    = {
    id:               `ep_${epNum}`,
    recId:            rec.id    || null,
    title:            rec.title || '',
    date:             rec.date  || new Date().toISOString().slice(0, 10),
    approved:         false,
    rejected:         false,
    note:             '',
    postUrl:          null,
    performanceScore: null,
  };

  series.episodes.push(ep);
  await saveSeries(data);
  logger.info(`[SeriesManager] Added episode ${ep.id} to series ${seriesId}: "${ep.title}"`);
  return ep;
}

async function approveEpisode(seriesId, episodeId, note) {
  const data   = await loadSeries();
  const series = data.series.find(s => s.id === seriesId);
  if (!series) return { success: false, error: 'Series not found' };
  const ep = series.episodes.find(e => e.id === episodeId);
  if (!ep) return { success: false, error: 'Episode not found' };

  ep.approved = true;
  ep.rejected = false;
  ep.note     = note || '';
  await saveSeries(data);
  logger.info(`[SeriesManager] Approved episode ${episodeId} in series ${seriesId}`);
  return { success: true };
}

async function rejectEpisode(seriesId, episodeId, note) {
  const data   = await loadSeries();
  const series = data.series.find(s => s.id === seriesId);
  if (!series) return { success: false, error: 'Series not found' };
  const ep = series.episodes.find(e => e.id === episodeId);
  if (!ep) return { success: false, error: 'Episode not found' };

  ep.rejected = true;
  ep.approved = false;
  ep.note     = note || '';
  await saveSeries(data);
  logger.info(`[SeriesManager] Rejected episode ${episodeId} in series ${seriesId}`);
  return { success: true };
}

async function getActiveSeries() {
  const data = await loadSeries();
  return (data.series || []).filter(s => s.status === 'active');
}

async function updateEpisodePerformance(seriesId, episodeId, score) {
  const data   = await loadSeries();
  const series = data.series.find(s => s.id === seriesId);
  if (!series) return { success: false, error: 'Series not found' };
  const ep = series.episodes.find(e => e.id === episodeId);
  if (!ep) return { success: false, error: 'Episode not found' };

  ep.performanceScore = score;
  await saveSeries(data);
  logger.info(`[SeriesManager] Updated performance for episode ${episodeId} in series ${seriesId}: ${score}`);
  return { success: true };
}

module.exports = {
  loadSeries,
  saveSeries,
  createSeries,
  addEpisode,
  approveEpisode,
  rejectEpisode,
  getActiveSeries,
  updateEpisodePerformance,
};
