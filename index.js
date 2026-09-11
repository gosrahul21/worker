const app = require('./src/app');
const config = require('./src/config');
const redisService = require('./src/services/redisService');
const { startScheduler, stopScheduler } = require('./src/worker/cronScheduler');
const { startNotionWorker, stopNotionWorker } = require('./src/worker/notionScheduler');

let server = null;

async function bootstrap() {
  console.log('==================================================');
  console.log('Starting Email & Notion Scheduler Worker Service');
  console.log('==================================================');

  // Initialize Redis Connection
  await redisService.connectRedis();

  // Start HTTP Server for Health Checks
  server = app.listen(config.port, () => {
    console.log(`[Express] Health API server running on port ${config.port}`);
    console.log(`[Express] Liveness check: http://localhost:${config.port}/health`);
    console.log(`[Express] Readiness check: http://localhost:${config.port}/health/readiness`);
  });

  // Start Background Email Cron Worker
  startScheduler();

  // Start Background Notion Task Worker
  startNotionWorker();
}

// Graceful Shutdown Handler
async function gracefulShutdown(signal) {
  console.log(`\n[System] Received ${signal}. Starting graceful shutdown...`);
  
  // 1. Stop taking new scheduled jobs
  stopScheduler();
  stopNotionWorker();

  // 2. Close HTTP Server
  if (server) {
    server.close(() => {
      console.log('[Express] HTTP server closed.');
    });
  }

  // 3. Disconnect Redis
  await redisService.disconnectRedis();

  console.log('[System] Cleanup finished. Exiting process.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

bootstrap().catch((err) => {
  console.error('[System] Fatal error during bootstrap:', err);
  process.exit(1);
});
