const { fetchEmailsSinceApi, filterImportantEmails } = require('./src/services/emailService');

async function main() {
  console.log('==================================================');
  console.log('Testing Gmail REST API Email Retrieval');
  console.log('==================================================');

  // Look back 7 days by default to capture recent emails
  const daysBack = process.argv[2] ? parseInt(process.argv[2], 10) : 7;
  const now = new Date();
  const startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  console.log(`Fetching emails between ${startDate.toISOString()} and ${now.toISOString()}...\n`);

  const rawEmails = await fetchEmailsSinceApi(startDate, now);

  console.log(`\n--------------------------------------------------`);
  console.log(`RAW FETCHED EMAILS COUNT: ${rawEmails.length}`);
  console.log(`--------------------------------------------------\n`);

  console.log(JSON.stringify(rawEmails, null, 2));

  const importantEmails = filterImportantEmails(rawEmails);

  console.log(`\n--------------------------------------------------`);
  console.log(`FILTERED IMPORTANT EMAILS COUNT: ${importantEmails.length}`);
  console.log(`--------------------------------------------------\n`);

  console.log(JSON.stringify(importantEmails, null, 2));
}

main().catch((err) => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
