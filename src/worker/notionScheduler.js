const cron = require('node-cron');
const config = require('../config');
const notionService = require('../services/notionService');
const telegramService = require('../services/telegramService');
const redisService = require('../services/redisService');

let morningTask = null;
let eveningTask = null;
let activeMonitorTask = null;

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * ☀️ Morning Scheduler Job
 */
async function runMorningBriefing(force = false) {
  const todayStr = getTodayString();

  if (!force) {
    const lastSentDate = await redisService.getNotionLastMorningDate();
    if (lastSentDate === todayStr) {
      console.log(`[NotionWorker] Morning Briefing already sent for today (${todayStr}). Skipping.`);
      return;
    }
  }

  console.log(`\n[NotionWorker] Running Morning Briefing...`);
  try {
    const tasks = await notionService.fetchAllTasks();
    const { pending, active } = notionService.categorizeTasks(tasks);

    let message;

    if (pending.length === 0 && active.length === 0) {
      message = `☀️ *Good Morning!*\n\n⚠️ You currently have *no active or pending tasks* in your Notion TaskList.\n👉 *Action Required*: Please take a moment to make a plan and add tasks for today!`;
    } else {
      message = `☀️ *Good Morning! Here is your daily task briefing:*\n\n`;

      if (active.length > 0) {
        message += `🔥 *Active Tasks (${active.length})*:\n`;
        active.forEach((t, i) => {
          const due = t.dueDate ? ` (Due: ${t.dueDate.toLocaleDateString()})` : '';
          message += `  ${i + 1}. *${t.name}* [Priority: ${t.priority}]${due}\n`;
        });
        message += `\n`;
      } else {
        message += `💡 *Active Tasks*: None currently set to "In progress".\n\n`;
      }

      if (pending.length > 0) {
        message += `📋 *Pending Tasks (${pending.length})*:\n`;
        pending.forEach((t, i) => {
          const due = t.dueDate ? ` (Due: ${t.dueDate.toLocaleDateString()})` : '';
          message += `  ${i + 1}. *${t.name}* [Priority: ${t.priority}]${due}\n`;
        });
      } else {
        message += `🎉 *Pending Tasks*: No pending tasks remaining!`;
      }
    }

    const success = await telegramService.sendTelegramMessage(message);
    if (success) {
      await redisService.setNotionLastMorningDate(todayStr);
      console.log(`[NotionWorker] ✅ Morning Briefing delivered and checkpoint saved for ${todayStr}.`);
    }
  } catch (err) {
    console.error('[NotionWorker] Error running Morning Briefing:', err.message);
  }
}

/**
 * 🌆 Evening Scheduler Job
 */
async function runEveningRecap(force = false) {
  const todayStr = getTodayString();

  if (!force) {
    const lastSentDate = await redisService.getNotionLastEveningDate();
    if (lastSentDate === todayStr) {
      console.log(`[NotionWorker] Evening Recap already sent for today (${todayStr}). Skipping.`);
      return;
    }
  }

  console.log(`\n[NotionWorker] Running Evening Recap...`);
  try {
    const tasks = await notionService.fetchAllTasks();
    const { pending, completedToday } = notionService.categorizeTasks(tasks);

    let message = `🌆 *Good Evening! Here is your daily work recap:*\n\n`;

    if (completedToday.length > 0) {
      message += `✅ *Completed Today (${completedToday.length})*:\n`;
      completedToday.forEach((t, i) => {
        message += `  ${i + 1}. ~${t.name}~\n`;
      });
      message += `\n`;
    } else {
      message += `ℹ️ *Completed Today*: No tasks marked as completed today.\n\n`;
    }

    if (pending.length > 0) {
      message += `📋 *Remaining Pending Tasks (${pending.length})*:\n`;
      pending.forEach((t, i) => {
        message += `  ${i + 1}. ${t.name}\n`;
      });
    } else {
      message += `🎉 *Outstanding Backlog*: All pending tasks have been completed! Great job today!`;
    }

    const success = await telegramService.sendTelegramMessage(message);
    if (success) {
      await redisService.setNotionLastEveningDate(todayStr);
      console.log(`[NotionWorker] ✅ Evening Recap delivered and checkpoint saved for ${todayStr}.`);
    }
  } catch (err) {
    console.error('[NotionWorker] Error running Evening Recap:', err.message);
  }
}

/**
 * ⏱️ 5-Minute Active Task Monitor (Working Hours)
 */
async function runActiveTaskMonitor() {
  const currentHour = new Date().getHours();
  const { workingHoursStart, workingHoursEnd } = config.notion;

  // Enforce user working hours window
  if (currentHour < workingHoursStart || currentHour >= workingHoursEnd) {
    console.log(`[NotionWorker] Outside working hours (${workingHoursStart}:00 - ${workingHoursEnd}:00). Skipping 5-min check.`);
    return;
  }

  console.log(`[NotionWorker] Running 5-minute Active Task Monitor...`);
  try {
    const tasks = await notionService.fetchAllTasks();
    const { pending, active } = notionService.categorizeTasks(tasks);
    const now = new Date();

    // Check 1: Expired Active Tasks
    for (const task of active) {
      if (task.dueDate && task.dueDate < now) {
        const msg = `⏰ *Task Deadline Alert!*\n\nYour active task "*${task.name}*" deadline (${task.dueDate.toLocaleString()}) has passed.\n👉 *Action Required*: Please update its deadline or mark it as completed in Notion!`;
        await telegramService.sendTelegramMessage(msg);
      }
    }

    // Check 2: Pending Tasks exist but NO Active Task in progress
    if (active.length === 0 && pending.length > 0) {
      const topPending = pending[0];
      const msg = `💡 *No Active Task Selected!*\n\nYou currently have *${pending.length} pending task(s)* but no task set to "In progress".\n👉 *Suggestion*: Start working on "*${topPending.name}*" or select an active task in Notion!`;
      await telegramService.sendTelegramMessage(msg);
    }
  } catch (err) {
    console.error('[NotionWorker] Error running Active Task Monitor:', err.message);
  }
}

/**
 * Catch-up check for Render / shared server restarts and external cron pings
 */
async function checkAndRunPendingNotionJobs() {
  const now = new Date();
  const currentHour = now.getHours();
  const morningHour = config.notion.morningHour || 9;
  const eveningHour = config.notion.eveningHour || 23;

  if (currentHour >= morningHour && currentHour < eveningHour) {
    await runMorningBriefing(false);
  }

  if (currentHour >= eveningHour) {
    await runEveningRecap(false);
  }

  // Always run active task monitor check during sync/catch-up
  await runActiveTaskMonitor();
}

/**
 * Start all Notion Cron Jobs
 */
async function startNotionWorker() {
  console.log(`[NotionWorker] Scheduling Morning Briefing (${config.notion.morningCron})`);
  morningTask = cron.schedule(config.notion.morningCron, () => runMorningBriefing(false));

  console.log(`[NotionWorker] Scheduling Evening Recap (${config.notion.eveningCron})`);
  eveningTask = cron.schedule(config.notion.eveningCron, () => runEveningRecap(false));

  console.log(`[NotionWorker] Scheduling Active Task Monitor (${config.notion.activeTaskCron})`);
  activeMonitorTask = cron.schedule(config.notion.activeTaskCron, runActiveTaskMonitor);

  // Catch-up check immediately on startup
  await checkAndRunPendingNotionJobs();
}

function stopNotionWorker() {
  if (morningTask) morningTask.stop();
  if (eveningTask) eveningTask.stop();
  if (activeMonitorTask) activeMonitorTask.stop();
  console.log('[NotionWorker] Notion scheduler stopped.');
}

module.exports = {
  startNotionWorker,
  stopNotionWorker,
  runMorningBriefing,
  runEveningRecap,
  runActiveTaskMonitor,
  checkAndRunPendingNotionJobs,
};
