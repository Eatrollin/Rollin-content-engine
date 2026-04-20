require('dotenv').config();
const fse    = require('fs-extra');
const path   = require('path');
const logger = require('./logger');
const { DATA_DIR } = require('./config');

const FOOTAGE_DIR = path.join(DATA_DIR, 'footage');

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.avi', '.mkv'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

function isVideo(filename) {
  return VIDEO_EXTS.includes(path.extname(filename).toLowerCase());
}

function isImage(filename) {
  return IMAGE_EXTS.includes(path.extname(filename).toLowerCase());
}

async function scanFolder(folderPath, folderName) {
  const items = [];
  const entries = await fse.readdir(folderPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      const children = await scanFolder(fullPath, entry.name);
      items.push(...children);
    } else if (isVideo(entry.name) || isImage(entry.name)) {
      const stat = await fse.stat(fullPath);
      items.push({
        id:          fullPath,
        name:        entry.name,
        nameClean:   path.basename(entry.name, path.extname(entry.name)).toLowerCase().replace(/[-_]/g, ' '),
        folderName,
        fullPath,
        isVideo:     isVideo(entry.name),
        isImage:     isImage(entry.name),
        sizeBytes:   stat.size,
        modifiedAt:  stat.mtime.toISOString(),
      });
    }
  }
  return items;
}

async function run() {
  logger.info('[FootageScanner] Scanning local footage library...');
  logger.info(`[FootageScanner] Footage directory: ${FOOTAGE_DIR}`);

  await fse.ensureDir(FOOTAGE_DIR);

  const exists = await fse.pathExists(FOOTAGE_DIR);
  if (!exists) {
    logger.warn('[FootageScanner] Footage directory does not exist — no footage available.');
    return [];
  }

  try {
    const library = await scanFolder(FOOTAGE_DIR, 'root');
    const videos  = library.filter(f => f.isVideo);
    const images  = library.filter(f => f.isImage);

    logger.info(`[FootageScanner] Found ${videos.length} video(s) and ${images.length} image(s)`);
    library.forEach(f => logger.info(`[FootageScanner]   ${f.isVideo ? 'video' : 'image'} ${f.name} (${f.folderName})`));

    return library;
  } catch (err) {
    logger.error(`[FootageScanner] Scan failed: ${err.message}`);
    return [];
  }
}

module.exports = { run, FOOTAGE_DIR };
