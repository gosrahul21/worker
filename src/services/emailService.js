const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const config = require('../config');

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Connects to Gmail IMAP using App Password and fetches emails since fromTimestamp
 */
async function fetchEmailsSince(fromTimestamp, toTimestamp = new Date()) {
  const { userEmail, appPassword } = config.gmail;

  const startDate = fromTimestamp || new Date(Date.now() - 60 * 60 * 1000);

  if (!userEmail || !appPassword) {
    console.log('[EmailService] Demo Mode: GMAIL_USER_EMAIL or GMAIL_APP_PASSWORD not set in .env. Using mock dataset.');
    return getMockGmailMessages(startDate, toTimestamp);
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: userEmail,
      pass: appPassword,
    },
    logger: false,
  });

  console.log(`[EmailService] Connecting to Gmail IMAP for ${userEmail}...`);
  const fetchedEmails = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Search for messages received since startDate
      for await (const message of client.fetch({ since: startDate }, { source: true, envelope: true, labels: true, flags: true })) {
        const parsed = await simpleParser(message.source);
        const timestamp = parsed.date || message.envelope.date || new Date();

        if (timestamp > startDate && timestamp <= toTimestamp) {
          const labels = Array.from(message.labels || []);
          const flags = Array.from(message.flags || []);
          const gmailLabelsHeader = parsed.headers.get('x-gmail-labels');
          const listUnsubscribe = parsed.headers.get('list-unsubscribe');
          
          let category = 'primary';
          const allLabelStr = (labels.join(' ') + ' ' + String(gmailLabelsHeader || '')).toLowerCase();
          
          if (allLabelStr.includes('promotion') || allLabelStr.includes('category_promotions')) category = 'promotions';
          else if (allLabelStr.includes('social') || allLabelStr.includes('category_social')) category = 'social';
          else if (allLabelStr.includes('update') || allLabelStr.includes('category_updates')) category = 'updates';

          // Extract plain text body or strip HTML body into clean text
          let rawBody = parsed.text || '';
          if (!rawBody.trim() && parsed.html) {
            rawBody = stripHtml(parsed.html);
          } else if (parsed.html && rawBody.trim().length < 20) {
            const stripped = stripHtml(parsed.html);
            if (stripped.length > rawBody.trim().length) {
              rawBody = stripped;
            }
          }

          fetchedEmails.push({
            id: message.uid ? message.uid.toString() : String(Math.random()),
            subject: parsed.subject || '(No Subject)',
            sender: parsed.from ? parsed.from.text : 'Unknown Sender',
            body: rawBody.trim(),
            timestamp,
            type: category,
            labelIds: [...labels, ...flags],
            hasUnsubscribeHeader: Boolean(listUnsubscribe),
          });
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    console.log(`[EmailService] Fetched ${fetchedEmails.length} messages via Gmail IMAP.`);
    return fetchedEmails;
  } catch (err) {
    console.error('[EmailService] Gmail IMAP Error:', err.message);
    return [];
  }
}

/**
 * Filter layer to identify important emails & exclude marketing, promotions, social, and updates.
 * Pure keyword and header-based filtration.
 */
function filterImportantEmails(emails) {
  // Keywords indicating marketing / bulk promotional content
  const promoKeywords = [
    'credit card', 'personal loan', 'pre-approved', 'apply for', 'ipo',
    'market volatility', 'special offer', 'discount', 'voucher', 'reward',
    'newsletter', 'deal of the day', 'unsubscribe', 'cashback', 'exclusive deal',
    'limited time offer', 'sale live', 'buy now', 'zero cost emi', 'flat % off',
    'renew policy', 'claim your', 'refer & earn', 'refer and earn', 'opt out',
    'opt-out', 'manage preferences', 'view in browser', 'view web version',
    'shop now', 'order now', 'don\'t miss out', 'exclusive offer', 'free trial',
    'investment opportunity', 'apply now', 'instant loan'
  ];

  // Common marketing / promotional sender patterns
  const promoSenderPatterns = [
    'info@', 'news@', 'mailer@', 'marketing@', 'digest@', 'newsletter@',
    'retailproducts@', 'promotions@', 'updates@', 'no-reply@', 'noreply@',
    'offers@', 'notifications@', 'bulletin@', 'deals@', 'sales@', 'alerts@',
    'kotak', 'icici', 'hdfcbank', 'axisbank', 'amazon.in', 'flipkart'
  ];

  const filtered = emails.filter((email) => {
    const subjectLower = (email.subject || '').toLowerCase();
    const senderLower = (email.sender || '').toLowerCase();
    const bodyLower = (email.body || '').toLowerCase();

    // Rule 1: Exclude if body is missing or empty (< 10 characters)
    if (!email.body || email.body.trim().length < 10) {
      return false;
    }

    // Rule 2: Exclude if email contains bulk unsubscribe header
    if (email.hasUnsubscribeHeader) {
      return false;
    }

    // Rule 3: Exclude if sender matches promotional patterns
    const matchesPromoSender = promoSenderPatterns.some((pattern) => senderLower.includes(pattern));
    if (matchesPromoSender) {
      return false;
    }

    // Rule 4: Exclude if subject OR body contains marketing keywords
    const matchesPromoKeyword = promoKeywords.some((kw) => subjectLower.includes(kw) || bodyLower.includes(kw));
    if (matchesPromoKeyword) {
      return false;
    }

    return true;
  });

  console.log(`[EmailService] Keyword & Header Filtration: ${emails.length} emails -> ${filtered.length} important emails remaining.`);
  return filtered;
}

/**
 * Mock fallback matching IMAP email object structure for local testing
 */
function getMockGmailMessages(startDate, toTimestamp) {
  const mockEmails = [
    {
      id: '101',
      subject: 'Quarterly Financial Review Required',
      sender: 'cfo@company.com',
      body: 'Please review the attached Q3 financial statements urgently.',
      timestamp: new Date(startDate.getTime() + 5 * 60 * 1000),
      type: 'primary',
    },
    {
      id: '102',
      subject: 'Weekly Newsletter - Tech Digest',
      sender: 'news@techdigest.io',
      body: 'Here are the latest updates in AI and Web Development.',
      timestamp: new Date(startDate.getTime() + 15 * 60 * 1000),
      type: 'promotions',
    },
    {
      id: '103',
      subject: 'Critical Security Alert: Server Memory High',
      sender: 'alerts@devops.internal',
      body: 'Server node-prod-04 CPU utilization exceeded 95%.',
      timestamp: new Date(startDate.getTime() + 25 * 60 * 1000),
      type: 'primary',
    },
  ];

  return mockEmails.filter((email) => email.timestamp > startDate && email.timestamp <= toTimestamp);
}

module.exports = {
  fetchEmailsSince,
  filterImportantEmails,
};
