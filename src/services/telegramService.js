const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const redisService = require('./redisService');
const notionService = require('./notionService');
const emailService = require('./emailService');

let bot = null;

function getControlPanelKeyboard(notificationsEnabled) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📊 Notion Status', callback_data: 'cmd_notion' },
          { text: '📧 Check Emails (1h)', callback_data: 'cmd_emails_1h' },
        ],
        [
          notificationsEnabled
            ? { text: '⏸️ Pause Notifications', callback_data: 'cmd_pause' }
            : { text: '▶️ Resume Notifications', callback_data: 'cmd_resume' },
        ],
        [
          { text: '☀️ Morning Briefing', callback_data: 'cmd_morning' },
          { text: '🌆 Evening Recap', callback_data: 'cmd_evening' },
        ],
      ],
    },
  };
}

async function sendControlPanel(chatId) {
  const isEnabled = await redisService.getNotificationsEnabled();
  const statusIcon = isEnabled ? '🟢 *Active*' : '🔴 *Paused*';
  
  const text = `⚙️ *Scheduler Worker Control Panel*\n\n` +
               `*Notification Status*: ${statusIcon}\n` +
               `*Cron Schedule*: \`${config.cronSchedule}\`\n\n` +
               `Choose an action from the buttons below or send a command:\n` +
               `• /notion - Check Notion tasks status\n` +
               `• /emails [hours] - Inspect emails (e.g. /emails 2)\n` +
               `• /stop - Pause notifications\n` +
               `• /resume - Resume notifications\n` +
               `• /morning - Trigger Morning Briefing\n` +
               `• /evening - Trigger Evening Recap`;

  return sendRawMessage(chatId, text, getControlPanelKeyboard(isEnabled));
}

async function sendRawMessage(chatId, text, extraOptions = {}) {
  if (bot) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extraOptions });
      return true;
    } catch (err) {
      // Fallback without parse_mode if Markdown parsing failed
      try {
        await bot.sendMessage(chatId, text, extraOptions);
        return true;
      } catch (innerErr) {
        console.error('[TelegramService] Error sending Telegram message:', innerErr.message);
        return false;
      }
    }
  } else {
    // Console fallback when bot token is not configured
    console.log(`[TelegramService (Console Fallback)] Sending message to ${chatId}:`);
    console.log(`--------------------------------------------------\n${text}\n--------------------------------------------------`);
    return true;
  }
}

/**
 * Send outbound Telegram Notification
 */
async function sendTelegramMessage(text, options = {}) {
  const targetChatId = options.chatId || config.telegram.chatId;
  const isDirectReply = options.isDirectReply || false;

  // Check notification state if not a direct command reply
  if (!isDirectReply) {
    const isEnabled = await redisService.getNotificationsEnabled();
    if (!isEnabled) {
      console.log('[TelegramService] Notifications are currently PAUSED. Suppressing automated background message.');
      return true; // Return true so background job considers processing complete
    }
  }

  if (!targetChatId) {
    console.warn('[TelegramService] No Telegram TELEGRAM_CHAT_ID set.');
    return true;
  }

  return sendRawMessage(targetChatId, text, options);
}

/**
 * Initialize Telegram Bot with polling & interactive commands
 */
function initBot() {
  if (bot) return bot;

  if (!config.telegram.botToken) {
    console.log('[TelegramService] TELEGRAM_BOT_TOKEN not provided. Interactive bot listener skipped.');
    return null;
  }

  console.log('[TelegramService] Initializing Telegram Bot in polling mode...');
  bot = new TelegramBot(config.telegram.botToken, { polling: true });

  bot.on('polling_error', (err) => {
    console.error('[TelegramService] Polling error:', err.message);
  });

  // /start & /help commands
  bot.onText(/\/(start|help)/, async (msg) => {
    await sendControlPanel(msg.chat.id);
  });

  // /stop & /pause commands
  bot.onText(/\/(stop|pause)/, async (msg) => {
    await redisService.setNotificationsEnabled(false);
    await sendRawMessage(msg.chat.id, `⏸️ *Notifications Paused*\n\nAll background email and Notion alerts are now paused.\nUse /resume or click below to resume.`, getControlPanelKeyboard(false));
  });

  // /resume & /start_notif commands
  bot.onText(/\/(resume|start_notif)/, async (msg) => {
    await redisService.setNotificationsEnabled(true);
    await sendRawMessage(msg.chat.id, `▶️ *Notifications Resumed*\n\nBackground email and Notion alerts are now active.\nUse /stop to pause anytime.`, getControlPanelKeyboard(true));
  });

  // /notion & /status commands
  bot.onText(/\/(notion|status)/, async (msg) => {
    await handleNotionStatusCommand(msg.chat.id);
  });

  // /emails [hours] command
  bot.onText(/\/emails(?:\s+(\d+))?/, async (msg, match) => {
    const hours = match && match[1] ? parseInt(match[1], 10) : 1;
    await handleCheckEmailsCommand(msg.chat.id, hours);
  });

  // /morning command
  bot.onText(/\/morning/, async (msg) => {
    const notionScheduler = require('../worker/notionScheduler');
    await sendRawMessage(msg.chat.id, '⏳ Triggering Morning Briefing...');
    await notionScheduler.runMorningBriefing(true);
  });

  // /evening command
  bot.onText(/\/evening/, async (msg) => {
    const notionScheduler = require('../worker/notionScheduler');
    await sendRawMessage(msg.chat.id, '⏳ Triggering Evening Recap...');
    await notionScheduler.runEveningRecap(true);
  });

  // Inline Keyboard Button Click Handler
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const action = query.data;

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (e) {}

    if (action === 'cmd_notion') {
      await handleNotionStatusCommand(chatId);
    } else if (action === 'cmd_emails_1h') {
      await handleCheckEmailsCommand(chatId, 1);
    } else if (action === 'cmd_pause') {
      await redisService.setNotificationsEnabled(false);
      await sendRawMessage(chatId, `⏸️ *Notifications Paused*`, getControlPanelKeyboard(false));
    } else if (action === 'cmd_resume') {
      await redisService.setNotificationsEnabled(true);
      await sendRawMessage(chatId, `▶️ *Notifications Resumed*`, getControlPanelKeyboard(true));
    } else if (action === 'cmd_morning') {
      const notionScheduler = require('../worker/notionScheduler');
      await sendRawMessage(chatId, '⏳ Triggering Morning Briefing...');
      await notionScheduler.runMorningBriefing(true);
    } else if (action === 'cmd_evening') {
      const notionScheduler = require('../worker/notionScheduler');
      await sendRawMessage(chatId, '⏳ Triggering Evening Recap...');
      await notionScheduler.runEveningRecap(true);
    }
  });

  return bot;
}

/**
 * Handler for /notion command & button
 */
async function handleNotionStatusCommand(chatId) {
  try {
    await sendRawMessage(chatId, '⏳ Querying Notion database...');
    const tasks = await notionService.fetchAllTasks();
    const { pending, active, completedToday } = notionService.categorizeTasks(tasks);

    let msg = `📊 *Notion Tasks Overview*\n\n`;
    
    msg += `🔥 *Active In-Progress Tasks (${active.length})*:\n`;
    if (active.length > 0) {
      active.forEach((t, i) => {
        const due = t.dueDate ? ` (Due: ${t.dueDate.toLocaleDateString()})` : '';
        msg += `  ${i + 1}. *${t.name}* [Priority: ${t.priority}]${due}\n`;
      });
    } else {
      msg += `  _(None in progress)_\n`;
    }
    msg += `\n`;

    msg += `📋 *Pending Backlog (${pending.length})*:\n`;
    if (pending.length > 0) {
      pending.slice(0, 7).forEach((t, i) => {
        const due = t.dueDate ? ` (Due: ${t.dueDate.toLocaleDateString()})` : '';
        msg += `  ${i + 1}. ${t.name}${due}\n`;
      });
      if (pending.length > 7) {
        msg += `  _...and ${pending.length - 7} more tasks_\n`;
      }
    } else {
      msg += `  _(No pending tasks remaining!)_\n`;
    }
    msg += `\n`;

    msg += `✅ *Completed Today (${completedToday.length})*:\n`;
    if (completedToday.length > 0) {
      completedToday.forEach((t, i) => {
        msg += `  ${i + 1}. ~${t.name}~\n`;
      });
    } else {
      msg += `  _(No tasks completed today yet)_\n`;
    }

    await sendRawMessage(chatId, msg);
  } catch (err) {
    await sendRawMessage(chatId, `❌ Error fetching Notion status: ${err.message}`);
  }
}

/**
 * Handler for /emails [hours] command & button
 */
async function handleCheckEmailsCommand(chatId, hours = 1) {
  try {
    const validHours = Math.max(1, Math.min(hours, 72)); // Cap between 1h and 72h
    await sendRawMessage(chatId, `⏳ Checking emails received in the last ${validHours} hour(s)...`);

    const now = new Date();
    const sinceDate = new Date(now.getTime() - validHours * 60 * 60 * 1000);

    const rawEmails = await emailService.fetchEmailsSince(sinceDate, now);
    const importantEmails = emailService.filterImportantEmails(rawEmails);

    if (importantEmails.length === 0) {
      await sendRawMessage(chatId, `📧 *Email Check (Last ${validHours}h)*\n\nNo important emails found in this timeframe.`);
      return;
    }

    let msg = `📧 *Important Emails (Last ${validHours}h - ${importantEmails.length} found)*:\n\n`;
    importantEmails.slice(0, 5).forEach((e, i) => {
      const timeStr = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
      msg += `*${i + 1}. ${e.subject}*\n`;
      msg += `👤 *From*: ${e.sender}\n`;
      msg += `🕒 *Time*: ${timeStr}\n\n`;
    });

    if (importantEmails.length > 5) {
      msg += `_...and ${importantEmails.length - 5} more emails._`;
    }

    await sendRawMessage(chatId, msg);
  } catch (err) {
    await sendRawMessage(chatId, `❌ Error checking emails: ${err.message}`);
  }
}

module.exports = {
  sendTelegramMessage,
  initBot,
  handleNotionStatusCommand,
  handleCheckEmailsCommand,
};
