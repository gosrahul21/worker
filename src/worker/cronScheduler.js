const cron = require('node-cron');
const config = require('../config');
const redisService = require('../services/redisService');
const emailService = require('../services/emailService');
const telegramService = require('../services/telegramService');

let scheduledTask = null;
let isJobRunning = false;

function formatEmailMessage(email) {
  const dateStr = email.timestamp ? new Date(email.timestamp).toLocaleString() : new Date().toLocaleString();
  const bodySnippet = (email.body || '').trim().slice(0, 500);
  return `📧 *New Email Alert*\n\n*Subject*: ${email.subject}\n*From*: ${email.sender}\n*Date*: ${dateStr}\n\n*Content*:\n${bodySnippet}${email.body && email.body.length > 500 ? '...' : ''}`;
}

async function runSchedulerJob() {
  if (isJobRunning) {
    console.log('[Scheduler] Job already in progress on this node. Skipping iteration.');
    return;
  }

  // Acquire distributed lock to prevent multi-instance race conditions
  const lockAcquired = await redisService.acquireLock();
  if (!lockAcquired) {
    console.log('[Scheduler] Another worker instance holds the lock. Skipping execution.');
    return;
  }

  isJobRunning = true;
  const executionStartTime = new Date();
  console.log(`\n==================================================`);
  console.log(`[Scheduler] Starting Cron Run at ${executionStartTime.toISOString()}`);
  console.log(`==================================================`);

  try {
    // 1. Fetch last processed timestamp from Redis
    const lastTimestamp = await redisService.getLastProcessedTimestamp();
    console.log(`[Scheduler] Last processed email timestamp from Redis: ${lastTimestamp ? lastTimestamp.toISOString() : 'None (First Run)'}`);

    // 2. Fetch emails between last timestamp and current execution time
    const rawEmails = await emailService.fetchEmailsSince(lastTimestamp, executionStartTime);
    console.log(`[Scheduler] Fetched ${rawEmails.length} emails in time window.`);

    if (rawEmails.length === 0) {
      console.log('[Scheduler] No new emails found. Job complete.');
      return;
    }

    // 3. Filter layer -> important emails (e.g. max 10)
    const importantEmails = emailService.filterImportantEmails(rawEmails);

    // Sort emails chronologically so timestamps progress forward
    importantEmails.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // 4. For Each email: Telegram -> Save to Redis
    for (const email of importantEmails) {
      console.log(`[Scheduler] Processing email ID ${email.id} (timestamp: ${new Date(email.timestamp).toISOString()})...`);
      
      const formattedText = formatEmailMessage(email);

      // Send Telegram message
      const telegramSuccess = await telegramService.sendTelegramMessage(formattedText);

      // On successful Telegram message sending, save current email timestamp to Redis
      if (telegramSuccess) {
        await redisService.updateLastProcessedTimestamp(email.timestamp);
        console.log(`[Scheduler] ✅ Successfully processed email ${email.id} & updated Redis checkpoint.`);
      } else {
        console.error(`[Scheduler] ❌ Failed to send Telegram message for email ${email.id}. Redis timestamp NOT updated.`);
      }
    }

    console.log(`[Scheduler] Batch completed successfully.`);
  } catch (err) {
    console.error('[Scheduler] Critical error in worker execution loop:', err);
  } finally {
    isJobRunning = false;
    await redisService.releaseLock();
    console.log(`[Scheduler] Lock released. Worker idle.\n`);
  }
}

function startScheduler() {
  console.log(`[Scheduler] Initializing cron schedule: "${config.cronSchedule}" (Timezone: ${config.timezone})`);
  scheduledTask = cron.schedule(config.cronSchedule, () => {
    runSchedulerJob();
  }, { timezone: config.timezone });
}

function stopScheduler() {
  if (scheduledTask) {
    console.log('[Scheduler] Stopping cron scheduler...');
    scheduledTask.stop();
    scheduledTask = null;
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  runSchedulerJob, // Exported for manual invocation / testing
};
