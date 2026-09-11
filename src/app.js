const express = require('express');
const redisService = require('./services/redisService');
const config = require('./config');

const app = express();

app.use(express.json());

const { runSchedulerJob } = require('./worker/cronScheduler');
const { checkAndRunPendingNotionJobs, runActiveTaskMonitor } = require('./worker/notionScheduler');

// Liveness check (checks if HTTP server is running & triggers background catchup)
app.get('/health', async (req, res) => {
  const isRedisHealthy = await redisService.checkHealth();
  
  // Trigger background catchup checks for Notion & Email on external pings
  checkAndRunPendingNotionJobs().catch((err) => console.error('[Health] Notion catchup error:', err));
  runSchedulerJob().catch((err) => console.error('[Health] Email catchup error:', err));

  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    services: {
      server: 'UP',
      redis: isRedisHealthy ? 'UP' : 'DOWN (Standalone / Mock Mode)',
    },
  });
});

// Dedicated trigger endpoint for external 30-min cron services (e.g. cron-job.org / UptimeRobot)
app.get('/cron/trigger', async (req, res) => {
  try {
    console.log('[Express] Received external cron trigger ping.');
    
    // Run Notion briefing/recap catchup check
    await checkAndRunPendingNotionJobs();
    
    // Run Active Task Monitor check
    await runActiveTaskMonitor();

    // Run Email worker catchup check
    await runSchedulerJob();

    return res.status(200).json({
      status: 'OK',
      message: 'Cron trigger & state catchup executed successfully.',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Express] Error executing cron trigger:', err.message);
    return res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// Deep readiness probe (used by Kubernetes / ALB health checks)
app.get('/health/readiness', async (req, res) => {
  const isRedisHealthy = await redisService.checkHealth();
  if (isRedisHealthy) {
    return res.status(200).json({ status: 'READY', redis: 'CONNECTED' });
  } else {
    return res.status(503).json({ status: 'NOT_READY', redis: 'DISCONNECTED' });
  }
});

module.exports = app;
