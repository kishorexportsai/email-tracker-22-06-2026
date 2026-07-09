// backend/gmailFetcher.js - SPECIFIC EMAIL TRACKING VERSION
// 
// Changes:
// - Tracks only 15 specific sender email addresses (not domains)
// - Checks only last 5 days of emails
// - Skips internal email tracking
// - Ignores all other emails
//

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { classifyEmail } = require('./aiClassifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── 15 TRACKED SENDER EMAILS ──────────────────────────────────────────
const TRACKED_SENDER_EMAILS = new Set([
  'nirvana.balsingh@wefashion.com',
  'ilona.van.de.schootbrugge@wefashion.com',
  'kurt@kurtklingberg.se',
  'cg@carebyme.dk',
  'ivy.ho@polarnopyret.se',
  'jo@lakor.dk',
  'stine@lakor.dk',
  'johnny.lai@polarnopyret.se',
  'rishabh.shrivastava@ul.com',
  'jeppe@lakor.dk',
  'fiona@littleones.ie',
  'mg@carebyme.dk',
  'bettina@gai-lisva.com',
  'camillad@luxkids.dk',
  'emma@emmamalena.com'
].map(e => e.toLowerCase()));

// ── SYSTEM/NOISE DETECTION ────────────────────────────────────────────
const OBVIOUS_SYSTEM_DOMAINS = [
  'railway.app', 'github.com', 'github.io', 'render.com', 'vercel.app',
  'google.com', 'accounts.google.com', 'googlemail.com',
  'linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'mailchimp.com', 'sendgrid.net', 'amazonses.com', 'brevo.com',
  'hdfcbank.com', 'sbi.co.in', 'icicibank.com', 'axisbank.com',
  'kotak.com', 'yesbank.in', 'indusind.com', 'canarabank.com',
  'barodampbank.com', 'pnbindia.com',
  'paytm.com', 'phonepe.com', 'razorpay.com', 'stripe.com', 'paypal.com',
  'indiamart.com', 'tradeindia.com', 'alibaba.com',
  'apollo.io', 'vultr.com', 'anthropic.com', 'dyad.sh',
  'zoom.us', 'slack.com', 'notion.so', 'asana.com', 'monday.com',
  'dhl.com', 'fedex.com', 'ups.com', 'aramex.com', 'shiprocket.com',
  'ul.com', 'intertek.com', 'tuv.com', 'dnvgl.com',
  'ftncv.com', 'napp.org', 'fairtrade.net',
];

const DO_NOT_REPLY_KEYWORDS = [
  'notification-only address', 'do not reply', 'do-not-reply',
  'cannot accept incoming', 'no-reply', 'noreply',
  'automated message', 'automated response', 'this is an automated',
  'please do not respond', 'please do not reply', 'do not respond to this',
  'mailer-daemon', 'postmaster', 'undeliverable', 'out of office',
];

const FYI_KEYWORDS = [
  'for your information', 'for information only', 'for your reference',
  'fyi', 'for awareness', 'please note', 'for your attention',
  'inward team has already sent', 'already processed', 'already handled',
  'in case you need', 'status update', 'information only',
  'tracking update', 'shipment status', 'order confirmation',
  'invoice attached', 'attached invoice',
];

const OBVIOUS_SYSTEM_KEYWORDS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'billing', 'invoice', 'receipt',
  'notification', 'alert', 'automated',
];

const GMAIL_LABELS_TO_SKIP = ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'SPAM'];

function isObviouslySystem(senderEmail, labelIds, listUnsub) {
  if (listUnsub) return true;
  if (labelIds.some(l => GMAIL_LABELS_TO_SKIP.includes(l))) return true;
  const lower = (senderEmail || '').toLowerCase();
  const domain = lower.split('@')[1] || '';
  if (OBVIOUS_SYSTEM_DOMAINS.some(d => domain.includes(d))) return true;
  if (OBVIOUS_SYSTEM_KEYWORDS.some(k => lower.includes(k))) return true;
  return false;
}

function detectByBodyContent(bodySnippet) {
  const lower = (bodySnippet || '').toLowerCase();
  if (DO_NOT_REPLY_KEYWORDS.some(k => lower.includes(k))) {
    return { status: 'no_reply_needed', reason: 'Notification-only email (body text)' };
  }
  if (FYI_KEYWORDS.some(k => lower.includes(k))) {
    return { status: 'no_reply_needed', reason: 'Informational email (for reference only)' };
  }
  return null;
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// ── TOKEN STORAGE ─────────────────────────────────────────────────────
async function getTokenFromSupabase(accountEmail) {
  const { data, error } = await supabase
    .from('users')
    .select('gmail_token')
    .eq('account_email', accountEmail)
    .single();

  if (error || !data?.gmail_token) {
    console.log(`[Gmail] No token for ${accountEmail}`);
    return null;
  }

  try {
    return typeof data.gmail_token === 'string' ? JSON.parse(data.gmail_token) : data.gmail_token;
  } catch {
    return null;
  }
}

async function saveTokenToSupabase(accountEmail, tokens) {
  const { error } = await supabase
    .from('users')
    .update({ gmail_token: JSON.stringify(tokens) })
    .eq('account_email', accountEmail);
  if (error) console.error(`[Gmail] Failed to save token for ${accountEmail}:`, error.message);
}

// ── FETCH: only tracked sender emails from last 5 days ──────────────────
async function fetchGmailEmails(accountEmail) {
  const tokens = await getTokenFromSupabase(accountEmail);
  if (!tokens) return 0;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );

  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', async (newTokens) => {
    await saveTokenToSupabase(accountEmail, { ...tokens, ...newTokens });
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // Calculate 5 days ago
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const afterDate = fiveDaysAgo.toISOString().split('T')[0];

    // Build query: only inbox, after 5 days ago
    const query = `in:inbox after:${afterDate}`;

    console.log(`[Gmail] Fetching ${accountEmail} — emails from last 5 days`);

    const messages = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 500
    });

    if (!messages.data.messages || messages.data.messages.length === 0) {
      console.log(`[Gmail] ${accountEmail}: no emails in last 5 days`);
      return 0;
    }

    let saved = 0;
    let ignoredNotTracked = 0;

    for (const msg of messages.data.messages) {
      // Check if already exists
      const { data: existing } = await supabase
        .from('emails')
        .select('id')
        .eq('email_id', msg.id)
        .single();

      if (existing) {
        continue; // Skip if already in DB
      }

      // Get full message details
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const headers = detail.data.payload.headers || [];
      const senderEmail = getHeader(headers, 'From').match(/<(.+?)>/)?.[1] || getHeader(headers, 'From');
      const senderName = getHeader(headers, 'From').split('<')[0].trim();

      // ── CHECK IF THIS IS ONE OF OUR 15 TRACKED EMAILS ──
      if (!TRACKED_SENDER_EMAILS.has(senderEmail.toLowerCase())) {
        ignoredNotTracked++;
        continue;
      }

      const subject = getHeader(headers, 'Subject') || '(No Subject)';
      const toHeader = getHeader(headers, 'To');
      const ccHeader = getHeader(headers, 'Cc');
      const listUnsub = getHeader(headers, 'List-Unsubscribe') || '';
      const receivedAtRaw = getHeader(headers, 'Date') || detail.data.internalDate;

      let receivedAt = new Date().toISOString();
      if (receivedAtRaw) {
        const parsed = new Date(receivedAtRaw);
        if (!isNaN(parsed.getTime())) {
          receivedAt = parsed.toISOString();
        }
      }

      // ── CLASSIFICATION ────────────────────────────────────
      const labelIds = detail.data.labelIds || [];
      const obviouslySystem = isObviouslySystem(senderEmail, labelIds, listUnsub);

      let status = 'unreplied';
      let aiReason = '';
      let aiConfidence = 'medium';

      if (obviouslySystem) {
        status = 'no_reply_needed';
        aiReason = 'Auto-detected: system/bulk email';
        aiConfidence = 'high';
      } else {
        const bodyDetection = detectByBodyContent(detail.data.snippet);
        if (bodyDetection) {
          status = bodyDetection.status;
          aiReason = bodyDetection.reason;
          aiConfidence = 'high';
        } else {
          const aiResult = await classifyEmailSafe({
            senderEmail, senderName, subject,
            bodyPreview: detail.data.snippet || '',
            toHeader, ccHeader, accountEmail
          });

          if (aiResult) {
            status = aiResult.needs_reply ? 'unreplied' : 'no_reply_needed';
            aiReason = aiResult.reason;
            aiConfidence = aiResult.confidence;
          }

          await new Promise(r => setTimeout(r, 5000)); // 12 RPM, under Gemini's 15 RPM cap
        }
      }

      const emailData = {
        email_id: msg.id,
        thread_id: detail.data.threadId,
        account: accountEmail,
        source: 'gmail',
        sender_name: senderName,
        sender_email: senderEmail,
        subject: subject,
        body_preview: detail.data.snippet || '',
        email_link: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
        received_at: receivedAt,
        status: status,
        is_system_generated: status === 'no_reply_needed',
        ai_reason: aiReason,
        ai_confidence: aiConfidence,
      };

      const { error } = await supabase.from('emails').insert(emailData);
      if (!error) saved++;
      else console.error(`[Gmail] Insert error for ${msg.id}:`, error.message);
    }

    console.log(`[Gmail] ${accountEmail}: ${saved} tracked emails saved, ${ignoredNotTracked} non-tracked emails ignored`);
    return saved;

  } catch (err) {
    console.error(`[Gmail] Error for ${accountEmail}:`, err.message);
    return 0;
  }
}

async function classifyEmailSafe(params, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await classifyEmail(params);
    } catch (err) {
      const is429 = err?.status === 429 || err?.message?.includes('429');
      const isLast = attempt === maxRetries;
      if (!is429 || isLast) {
        console.error(`[AI] Failed (attempt ${attempt + 1}):`, err.message);
        return null;
      }
      const backoffMs = 5000 * Math.pow(2, attempt);
      console.log(`[AI] Rate limited. Retrying in ${backoffMs / 1000}s...`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  return null;
}

// ── REPLY CHECK: only tracked buyer emails still status='unreplied' ─────
async function checkPendingReplies(accountEmail, gmail) {
  try {
    const { data: pending, error } = await supabase
      .from('emails')
      .select('id, thread_id, received_at, subject')
      .eq('account', accountEmail)
      .eq('status', 'unreplied');

    if (error) {
      console.error(`[Gmail] Pending query error for ${accountEmail}:`, error.message);
      return;
    }

    if (!pending?.length) {
      console.log(`[Gmail] ${accountEmail}: no pending emails to check`);
      return;
    }

    console.log(`[Gmail] ${accountEmail}: checking ${pending.length} pending threads`);

    const toMarkReplied = [];

    for (const email of pending) {
      if (!email.thread_id) continue;

      try {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: email.thread_id,
          format: 'metadata',
          metadataHeaders: ['From', 'Date']
        });

        const messages = thread.data.messages || [];
        const receivedAtMs = new Date(email.received_at).getTime();

        const hasReply = messages.some(m => {
          const isSent = (m.labelIds || []).includes('SENT');
          const msgDateMs = parseInt(m.internalDate || '0');
          return isSent && msgDateMs > receivedAtMs;
        });

        if (hasReply) toMarkReplied.push(email.id);

      } catch (threadErr) {
        console.error(`[Gmail] Thread check failed for ${email.subject?.slice(0, 30)}:`, threadErr.message);
      }
    }

    if (toMarkReplied.length) {
      await supabase.from('emails').update({
        status: 'replied',
        replied_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).in('id', toMarkReplied);
      console.log(`[Gmail] ${accountEmail}: ${toMarkReplied.length} marked replied`);
    } else {
      console.log(`[Gmail] ${accountEmail}: none of the pending threads have replies yet`);
    }

  } catch (err) {
    console.error(`[Gmail] Reply check error for ${accountEmail}:`, err.message);
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────
async function runGmailFetcher() {
  const { data: users, error } = await supabase
    .from('users')
    .select('account_email, gmail_token')
    .not('gmail_token', 'is', null);

  if (error) {
    console.error('[Gmail] Supabase error:', error.message);
    return;
  }

  const envAccounts = (process.env.GMAIL_ACCOUNTS || '')
    .split(',').map(e => e.trim()).filter(Boolean);

  const allAccounts = [...new Set([
    ...(users || []).map(u => u.account_email),
    ...envAccounts
  ])];

  if (!allAccounts.length) {
    console.log('[Gmail] No connected accounts');
    return;
  }

  console.log(`[Gmail] Fetching ${allAccounts.length} accounts`);

  for (const account of allAccounts) {
    const tokens = await getTokenFromSupabase(account);
    if (!tokens) continue;

    await fetchGmailEmails(account);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    await checkPendingReplies(account, gmail);
  }

  console.log('[Gmail] Done.');
}

async function runReplyCheckOnly() {
  const { data: users } = await supabase
    .from('users')
    .select('account_email, gmail_token')
    .not('gmail_token', 'is', null);

  const envAccounts = (process.env.GMAIL_ACCOUNTS || '')
    .split(',').map(e => e.trim()).filter(Boolean);

  const allAccounts = [...new Set([
    ...(users || []).map(u => u.account_email),
    ...envAccounts
  ])];

  if (!allAccounts.length) return;

  for (const account of allAccounts) {
    const tokens = await getTokenFromSupabase(account);
    if (!tokens) continue;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    await checkPendingReplies(account, gmail);
  }
}

module.exports = { runGmailFetcher, saveTokenToSupabase, runReplyCheckOnly };
