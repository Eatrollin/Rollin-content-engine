require('dotenv').config();

const axios  = require('axios');
const logger = require('./logger');

const ROOT_FOLDER_ID = '12mkXfiKYSstibH1kTpjAy1ACDmWrBVtS';
const DRIVE_BASE     = 'https://www.googleapis.com/drive/v3';

const VIDEO_MIMES = new Set([
  'video/mp4', 'video/quicktime', 'video/x-m4v',
  'video/x-msvideo', 'video/x-matroska', 'video/mpeg',
]);
const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp',
]);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}
function isVideo(f) { return VIDEO_MIMES.has(f.mimeType) || VIDEO_EXTS.has(extOf(f.name)); }
function isImage(f) { return IMAGE_MIMES.has(f.mimeType) || IMAGE_EXTS.has(extOf(f.name)); }

async function listFolder(folderId, folderName, apiKey) {
  const items = [];
  let pageToken = null;

  do {
    const params = {
      q:         `'${folderId}' in parents and trashed = false`,
      key:       apiKey,
      fields:    'nextPageToken,files(id,name,mimeType,webViewLink,webContentLink)',
      pageSize:  1000,
    };
    if (pageToken) params.pageToken = pageToken;

    const res   = await axios.get(`${DRIVE_BASE}/files`, { params });
    const files = res.data.files || [];
    pageToken   = res.data.nextPageToken || null;

    for (const file of files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        const children = await listFolder(file.id, file.name, apiKey);
        items.push(...children);
      } else if (isVideo(file) || isImage(file)) {
        items.push({
          id:             file.id,
          name:           file.name,
          folderId,
          folderName,
          mimeType:       file.mimeType,
          webViewLink:    file.webViewLink    || null,
          webContentLink: file.webContentLink || null,
          isVideo:        isVideo(file),
          isImage:        isImage(file),
        });
      }
    }
  } while (pageToken);

  return items;
}

async function run() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[FootageScanner] GOOGLE_API_KEY not set — skipping Drive scan.');
    return [];
  }

  logger.info('[FootageScanner] Scanning Google Drive footage library...');

  try {
    const rootRes  = await axios.get(`${DRIVE_BASE}/files/${ROOT_FOLDER_ID}`, {
      params: { key: apiKey, fields: 'id,name' },
    });
    const rootName = rootRes.data.name || 'Rollin-raw-content';

    const library = await listFolder(ROOT_FOLDER_ID, rootName, apiKey);

    const clips  = library.filter(f => f.isVideo);
    const images = library.filter(f => f.isImage);
    logger.info(`[FootageScanner] Found ${clips.length} video clip(s) and ${images.length} image(s) (${library.length} total).`);

    return library;
  } catch (err) {
    logger.error(`[FootageScanner] Drive scan failed: ${err.message}`);
    return [];
  }
}

module.exports = { run };
