require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  redis: {
    upstashRestUrl: process.env.UPSTASH_REDIS_REST_URL || undefined,
    upstashRestToken: process.env.UPSTASH_REDIS_REST_TOKEN || undefined,
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *', // Default: every 5 minutes
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  gmail: {
    userEmail: process.env.GMAIL_USER_EMAIL || '',
    appPassword: process.env.GMAIL_APP_PASSWORD || '',
    fetchMode: process.env.GMAIL_FETCH_MODE || 'api', // 'api' or 'imap'
    clientId: process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    accessToken: process.env.GMAIL_ACCESS_TOKEN || '',
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY || '',
    databaseId: process.env.NOTION_DATABASE_ID || '',
    dataSourceId: process.env.NOTION_DATA_SOURCE_ID || '',
    morningCron: process.env.NOTION_MORNING_CRON || '0 9 * * *', // 9:00 AM daily
    eveningCron: process.env.NOTION_EVENING_CRON || '0 18 * * *', // 6:00 PM daily
    activeTaskCron: process.env.NOTION_ACTIVE_TASK_CRON || '*/5 * * * *', // Every 5 minutes
    workingHoursStart: parseInt(process.env.WORKING_HOURS_START || '9', 10), // 9 AM
    workingHoursEnd: parseInt(process.env.WORKING_HOURS_END || '23', 10), // 11 PM (23:00)
    morningHour: parseInt(process.env.NOTION_MORNING_HOUR || '9', 10),
    eveningHour: parseInt(process.env.NOTION_EVENING_HOUR || '18', 10), // 6 PM
  },
  redisKeys: {
    lastProcessedTimestamp: 'email_worker:last_processed_timestamp',
    distributedLock: 'email_worker:lock',
    notionLastMorningDate: 'notion:last_morning_sent_date',
    notionLastEveningDate: 'notion:last_evening_sent_date',
    notificationsEnabled: 'scheduler:notifications_enabled',
  },
};
