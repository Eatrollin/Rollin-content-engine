require('dotenv').config();

const winston = require('winston');
const path = require('path');
const fse = require('fs-extra');
const { DATA_DIR } = require('./config');

const LOG_DIR = path.join(DATA_DIR, 'logs');
fse.ensureDirSync(LOG_DIR);

// Returns today's log file path in Detroit local time
function getLogFilePath() {
  const now = new Date();
  const detroit = new Date(now.toLocaleString('en-US', { timeZone: 'America/Detroit' }));
  const yyyy = detroit.getFullYear();
  const mm = String(detroit.getMonth() + 1).padStart(2, '0');
  const dd = String(detroit.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `${yyyy}-${mm}-${dd}.log`);
}

// Shared log format for the file transport
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}`;
  })
);

// Console format — colorized, compact
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level}: ${message}`;
  })
);

// Build the file transport pointing at today's dated log file
function makeFileTransport() {
  return new winston.transports.File({
    filename: getLogFilePath(),
    format: fileFormat,
  });
}

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    makeFileTransport(),
  ],
});

// At midnight Detroit time, swap the file transport to the new day's log file
// This keeps the process running across midnight without stale log paths
const cron = require('node-cron');
cron.schedule(
  '1 0 * * *',
  () => {
    const oldFileTransports = logger.transports.filter(
      (t) => t instanceof winston.transports.File
    );
    oldFileTransports.forEach((t) => logger.remove(t));
    logger.add(makeFileTransport());
    logger.info('Log file rotated for new day.');
  },
  { timezone: 'America/Detroit' }
);

module.exports = logger;
