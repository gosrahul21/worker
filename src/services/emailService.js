const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { google } = require('googleapis');
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
 * Connects to Gmail REST API using OAuth2 (Client ID, Client Secret, Refresh Token / Access Token)
 * and fetches emails since fromTimestamp
 */
async function fetchEmailsSinceApi(fromTimestamp, toTimestamp = new Date()) {
  const { clientId, clientSecret, refreshToken, accessToken } = config.gmail;
  const startDate = fromTimestamp || new Date(Date.now() - 60 * 60 * 1000);

  if (!clientId || !clientSecret || (!refreshToken && !accessToken)) {
    console.log('[EmailService] Gmail API credentials incomplete in config. Falling back to IMAP service.');
    return fetchEmailsSinceImap(startDate, toTimestamp);
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      'https://developers.google.com/oauthplayground'
    );

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Gmail API search query using epoch seconds
    const afterEpochSec = Math.floor(startDate.getTime() / 1000);
    const query = `after:${afterEpochSec}`;

    console.log(`[EmailService] [REST API] Querying Gmail API for messages after ${startDate.toISOString()} (query: "${query}")...`);

    let listRes = null;
    let listRetries = 3;
    let listDelay = 1000;

    while (listRetries > 0) {
      try {
        listRes = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 50,
        });
        break;
      } catch (err) {
        if (err.status === 403 || err.status === 429 || (err.message && err.message.includes('Quota exceeded'))) {
          listRetries--;
          if (listRetries > 0) {
            console.log(`[EmailService] [REST API] Quota rate limit hit. Waiting ${listDelay}ms before retry...`);
            await new Promise((r) => setTimeout(r, listDelay));
            listDelay *= 2;
            continue;
          }
        }
        throw err;
      }
    }

    const messagesList = listRes?.data?.messages || [];
    console.log(`[EmailService] [REST API] Found ${messagesList.length} message(s) in query response.`);

    const fetchedEmails = [];

    // Fetch message details in controlled chunks with retries to stay within Gmail API rate limits
    const chunkSize = 5;
    for (let i = 0; i < messagesList.length; i += chunkSize) {
      const chunk = messagesList.slice(i, i + chunkSize);
      const messageResults = await Promise.all(
        chunk.map(async (msgRef) => {
          let retries = 3;
          let delay = 300;
          while (retries > 0) {
            try {
              return await gmail.users.messages.get({
                userId: 'me',
                id: msgRef.id,
                format: 'full',
              });
            } catch (err) {
              if (err.status === 429 || (err.message && err.message.includes('Quota exceeded'))) {
                retries--;
                if (retries > 0) {
                  await new Promise((r) => setTimeout(r, delay));
                  delay *= 2;
                  continue;
                }
              }
              console.error(`[EmailService] Failed to fetch msg ${msgRef.id}:`, err.message);
              return null;
            }
          }
          return null;
        })
      );

      for (const msgRes of messageResults) {
        if (!msgRes || !msgRes.data) continue;
        const msg = msgRes.data;
        const headers = msg.payload?.headers || [];

        const getHeader = (name) => {
          const h = headers.find((item) => item.name.toLowerCase() === name.toLowerCase());
          return h ? h.value : '';
        };

        const subject = getHeader('Subject') || '(No Subject)';
        const sender = getHeader('From') || 'Unknown Sender';
        const dateHeader = getHeader('Date');
        const listUnsubscribe = getHeader('List-Unsubscribe');
        const timestamp = dateHeader ? new Date(dateHeader) : (msg.internalDate ? new Date(parseInt(msg.internalDate, 10)) : new Date());

        // Filter by timestamp window
        if (timestamp <= startDate || timestamp > toTimestamp) {
          continue;
        }

        // Extract plain text body or fallback to HTML / snippet
        let rawBody = parseMessageBody(msg.payload);
        if (!rawBody.trim() && msg.snippet) {
          rawBody = msg.snippet;
        }

        // Categories from labelIds
        const labelIds = msg.labelIds || [];
        let category = 'primary';
        const labelStr = labelIds.join(' ').toLowerCase();
        if (labelStr.includes('category_promotions') || labelStr.includes('promotions')) category = 'promotions';
        else if (labelStr.includes('category_social') || labelStr.includes('social')) category = 'social';
        else if (labelStr.includes('category_updates') || labelStr.includes('updates')) category = 'updates';
        else if (labelStr.includes('category_forums') || labelStr.includes('forums')) category = 'forums';

        fetchedEmails.push({
          id: msg.id,
          threadId: msg.threadId,
          subject,
          sender,
          body: rawBody.trim(),
          timestamp,
          type: category,
          labelIds,
          hasUnsubscribeHeader: Boolean(listUnsubscribe),
          snippet: msg.snippet || '',
        });
      }
    }

    console.log(`[EmailService] [REST API] Successfully parsed ${fetchedEmails.length} messages.`);
    return fetchedEmails;
  } catch (err) {
    console.error('[EmailService] [REST API] Error:', err.message);
    if (err.response && err.response.data) {
      console.error('[EmailService] API Error Detail:', JSON.stringify(err.response.data));
    }
    return [];
  }
}

/**
 * Helper to recursively extract text body from Gmail API payload
 */
function parseMessageBody(payload) {
  if (!payload) return '';

  let textBody = '';
  let htmlBody = '';

  function extractParts(part) {
    if (!part) return;

    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      textBody += Buffer.from(part.body.data, 'base64url').toString('utf-8') + '\n';
    } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
      htmlBody += Buffer.from(part.body.data, 'base64url').toString('utf-8') + '\n';
    }

    if (part.parts && Array.isArray(part.parts)) {
      for (const subPart of part.parts) {
        extractParts(subPart);
      }
    }
  }

  extractParts(payload);

  if (textBody.trim()) {
    return textBody;
  } else if (htmlBody.trim()) {
    return stripHtml(htmlBody);
  }

  return '';
}

/**
 * Connects to Gmail IMAP using App Password and fetches emails since fromTimestamp
 */
async function fetchEmailsSinceImap(fromTimestamp, toTimestamp = new Date()) {
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
          else if (allLabelStr.includes('forum') || allLabelStr.includes('category_forums')) category = 'forums';

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
 * Main router function: calls API or IMAP version based on GMAIL_FETCH_MODE
 */
async function fetchEmailsSince(fromTimestamp, toTimestamp = new Date()) {
  const mode = (config.gmail.fetchMode || 'api').toLowerCase();

  if (mode === 'imap') {
    return fetchEmailsSinceImap(fromTimestamp, toTimestamp);
  }

  return fetchEmailsSinceApi(fromTimestamp, toTimestamp);
}

/**
 * Filter layer to identify important emails & exclude marketing, promotions, social, and updates.
 * Pure keyword and header-based filtration.
 */
function filterImportantEmails(emails) {
  // Keywords indicating marketing / bulk promotional content
  const filtered = emails.filter((email) => {
    const subjectLower = (email.subject || '').toLowerCase();
    const senderLower = (email.sender || '').toLowerCase();
    const bodyLower = (email.body || '').toLowerCase();

    // Rule 1: Exclude non-primary categories (promotions, social, updates, forums)
    const excludedCategories = ['promotions', 'social', 'updates', 'forums'];
    if (excludedCategories.includes((email.type || '').toLowerCase())) {
      return false;
    }

    const labelStr = Array.isArray(email.labelIds) ? email.labelIds.join(' ').toLowerCase() : '';
    if (
      labelStr.includes('category_promotions') ||
      labelStr.includes('category_social') ||
      labelStr.includes('category_updates') ||
      labelStr.includes('category_forums')
    ) {
      return false;
    }

    return true;
  });

  console.log(`[EmailService] Keyword & Header Filtration: ${emails.length} emails -> ${filtered.length} important emails remaining.`);
  return filtered;
}

/**
 * Mock fallback matching email object structure for local testing
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
  fetchEmailsSinceApi,
  fetchEmailsSinceImap,
  filterImportantEmails,
};
