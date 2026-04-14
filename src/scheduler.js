require('dotenv').config();

const cron = require('node-cron');
const logger = require('./logger');

// ─── Schedule is read from .env — change CRON_SCHEDULE to adjust run time ───
// Default: 0 6 * * * = 6:00am every day, Detroit time
// Examples:
//   30 5 * * *   = 5:30am daily
//   0 7 * * 1-5  = 7:00am weekdays only
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 6 * * *';

function register() {
  if (!cron.validate(CRON_SCHEDULE)) {
    logger.error(`Invalid CRON_SCHEDULE in .env: "${CRON_SCHEDULE}"`);
    logger.error('Falling back to default: 0 6 * * * (6:00am daily)');
  }

  logger.info(`Scheduler registered — cron: "${CRON_SCHEDULE}" (America/Detroit)`);
  logger.info('Pipeline will fire automatically at the scheduled time.');
  logger.info('To run manually right now: node src/pipeline.js');

  cron.schedule(
    cron.validate(CRON_SCHEDULE) ? CRON_SCHEDULE : '0 6 * * *',
    async () => {
      logger.info('');
      logger.info('══════════════════════════════════════════════════');
      logger.info('  ROLLIN CONTENT ENGINE — SCHEDULED RUN TRIGGERED ');
      logger.info(`  ${new Date().toLocaleString('en-US', { timeZone: 'America/Detroit' })}`);
      logger.info('══════════════════════════════════════════════════');

      try {
        const pipeline = require('./pipeline');
        await pipeline.run();
        logger.info('══════════════════════════════════════════════════');
        logger.info('  SCHEDULED RUN COMPLETED SUCCESSFULLY            ');
        logger.info('══════════════════════════════════════════════════');
        logger.info('');
      } catch (err) {
        logger.error('══════════════════════════════════════════════════');
        logger.error('  SCHEDULED RUN FAILED');
        logger.error(`  ${err.message}`);
        logger.error('══════════════════════════════════════════════════');
        logger.error(err.stack);
        logger.info('');
      }
    },
    { timezone: 'America/Detroit' }
  );
}

module.exports = { register };
