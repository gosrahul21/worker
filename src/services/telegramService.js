const config = require('../config');

/**
 * Telegram Notification Service
 */
async function sendTelegramMessage(text) {
  console.log(`[TelegramService] Sending message to chat ${config.telegram.chatId || 'default_chat'}:`);
  console.log(`--------------------------------------------------\n${text}\n--------------------------------------------------`);

  if (config.telegram.botToken && config.telegram.chatId) {
    // In production, invoke Telegram API:
    // await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ chat_id: config.telegram.chatId, text, parse_mode: 'Markdown' })
    // });
  }

  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 200));
  return true;
}

module.exports = {
  sendTelegramMessage,
};
