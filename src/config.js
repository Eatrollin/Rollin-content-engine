const path = require('path');
const os   = require('os');

// In development, data lives alongside the project on the local machine.
// In production (Railway Volumes), data lives at /app/data (or DATA_DIR env override).
const DATA_DIR = process.env.NODE_ENV === 'development'
  ? path.join(os.homedir(), 'Desktop', 'rollin-content-engine', 'data')
  : (process.env.DATA_DIR || '/app/data');

module.exports = { DATA_DIR };
