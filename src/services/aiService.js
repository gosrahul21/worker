const Bottleneck = require('bottleneck');
const config = require('../config');

// Configured for strict 2 requests per minute pacing (30 seconds per request)
const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: config.rateLimit.minTimeMs, // 30,000ms between jobs = 2 requests/min
});

limiter.on('failed', async (error, jobInfo) => {
  console.error(`[AIService] Rate-limited job ${jobInfo.options.id} failed:`, error.message);
});

/**
 * AI filtration layer & AI text update.
 * Wrapped in rate limiter to ensure max 2 requests per minute.
 */
const processEmailWithAI = limiter.wrap(async function (email) {
  console.log(`[AIService] [${new Date().toISOString()}] Processing email "${email.subject}" via AI layer...`);

  // Simulate AI LLM evaluation & summarization call
  // Replace with OpenAI / Gemini API call
  await new Promise((resolve) => setTimeout(resolve, 500)); // Simulating network call latency

  const aiSummary = `📌 *AI Summary*: ${email.subject}\n\n*From*: ${email.sender}\n*Details*: ${email.body}\n*Priority*: HIGH`;
  
  return {
    originalEmail: email,
    formattedText: aiSummary,
    processedAt: new Date(),
  };
});

module.exports = {
  processEmailWithAI,
  limiter,
};
