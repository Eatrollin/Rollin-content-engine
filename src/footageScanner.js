require('dotenv').config();
const axios  = require('axios');
const fse    = require('fs-extra');
const path   = require('path');
const logger = require('./logger');

const ROOT_FOLDER_ID = '12mkXfiKYSstibH1kTpjAy1ACDmWrBVtS';
const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.avi', '.mkv'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

function isVideo(name) { return VIDEO_EXTS.includes(path.extname(name).toLowerCase()); }
function isImage(name) { return IMAGE_EXTS.includes(path.extname(name).toLowerCase()); }

async function listPublicFolder(folderId) {
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    timeout: 30000,
  });

  const html = res.data;

  // Extract file data from Google Drive's embedded JSON
  const matches = [...html.matchAll(/\["([a-zA-Z0-9_-]{25,})".*?"([^"]+\.(mp4|mov|m4v|avi|mkv|jpg|jpeg|png|webp))"/gi)];

  const items = [];
  const seen  = new Set();

  for (const match of matches) {
    const fileId   = match[1];
    const fileName = match[2];
    if (seen.has(fileId)) continue;
    seen.add(fileId);

    if (isVideo(fileName) || isImage(fileName)) {
      items.push({
        id:          fileId,
        name:        fileName,
        nameClean:   path.basename(fileName, path.extname(fileName)).toLowerCase().replace(/[-_]/g, ' '),
        folderId,
        webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        isVideo:     isVideo(fileName),
        isImage:     isImage(fileName),
      });
    }
  }

  return items;
}

async function run() {
  logger.info('[FootageScanner] Scanning public Google Drive footage library...');
  logger.info(`[FootageScanner] Folder: https://drive.google.com/drive/folders/${ROOT_FOLDER_ID}`);

  try {
    const library = await listPublicFolder(ROOT_FOLDER_ID);
    const videos  = library.filter(f => f.isVideo);
    const images  = library.filter(f => f.isImage);

    logger.info(`[FootageScanner] Found ${videos.length} video(s) and ${images.length} image(s)`);
    library.forEach(f => logger.info(`[FootageScanner]   ${f.isVideo ? 'video' : 'image'} ${f.name}`));

    return library;
  } catch (err) {
    logger.error(`[FootageScanner] Scan failed: ${err.message}`);
    return [];
  }
}

module.exports = { run };
