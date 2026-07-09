require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { classifyEmail } = require('./aiClassifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

const OBVIOUS_SYSTEM_DOMAINS = ['railway.app', 'github.com', 'render.com', 'google.com', 'linkedin.com', 'mailchimp.com', 'ul.com'];
const GMAIL_LABELS_TO_SKIP = ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'SPAM'];

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

async function getTokenFromSupabase(accountEmail) {
  const { data, error } = await supabase.from('users').select('gmail_token').eq('account_email', accountEmail).single();
  if (error || !data?.gmail_token) return null;
  try {
    return typeof data.gmail_token === 'string' ? JSON.parse(data.gmail_token) : data.gmail_token;
  } catch {
    return null;
  }
}

async function saveTokenToSupabase(accountEmail, tokens) {
  await supabase.from('users').update({ gmail_token: JSON.stringify(tokens) }).eq('account_email', accountEmail);
}

async function fetchGmailEmails(accountEmail) {
  const tokens = await getTokenFromSupabase(accountEmail);
  if (!tokens) return 0;

  const oauth2Client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', async (newTokens) => {
    await saveTokenToSupabase(accountEmail, { ...tokens, ...newTokens });
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const afterDate = fiveDaysAgo.toISOString().split('T')[0];
    const query = `in:inbox after:${afterDate}`;

    console.log(`[Gmail] Fetching ${accountEmail}`);

    const messages = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 500 });

    if (!messages.data.messages || messages.data.messages.length === 0) {
      console.log(`[Gmail] No emails`);
      return 0;
    }

    let saved = 0;
    let skipped = 0;

    for (const msg of messages.data.messages) {
      const { data: existing } = await supabase.from('emails').select('id').eq('email_id', msg.id).single();
      if (existing) continue;

      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = detail.data.payload.headers || [];
      const fromHeader = getHeader(headers, 'From') || '';
      
      let senderEmail = '';
      const match = fromHeader.match(/<(.+?)>/);
      if (match && match[1]) {
        senderEmail = match[1].toLowerCase().trim();
      } else {
        senderEmail = fromHeader.toLowerCase().trim();
      }

      if (!TRACKED_SENDER_EMAILS.has(senderEmail)) {
        skipped++;
        console.log(`[Gmail] SKIP: ${senderEmail}`);
        continue;
      }

      console.log(`[Gmail] TRACK: ${senderEmail}`);

      const subject = getHeader(headers, 'Subject') || '(No Subject)';
      const toHeader = getHeader(headers, 'To');
      const ccHeader = getHeader(headers, 'Cc');
      const receivedAtRaw = getHeader(headers, 'Date');

      let receivedAt = new Date().toISOString();
      if (receivedAtRaw) {
        const parsed = new Date(receivedAtRaw);
        if (!isNaN(parsed.getTime())) {
          receivedAt = parsed.toISOString();
        }
      }

      const emailData = {
        email_id: msg.id,
        thread_id: detail.data.threadId,
        account: accountEmail,
        source: 'gmail',
        sender_name: fromHeader.split('<')[0].trim(),
        sender_email: senderEmail,
        subject: subject,
        body_preview: detail.data.snippet || '',
        email_link: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
        received_at: receivedAt,
        status: 'unreplied',
        is_system_generated: false,
        ai_reason: '',
        ai_confidence: 'medium',
      };

      const { error } = await supabase.from('emails').insert(emailData);
      if (!error) saved++;
    }

    console.log(`[Gmail] RESULT: ${saved} TRACKED, ${skipped} SKIPPED`);
    return saved;
  } catch (err) {
    console.error(`[Gmail] Error:`, err.message);
    return 0;
  }
}

async function checkPendingReplies(accountEmail, gmail) {
  try {
    const { data: pending } = await supabase.from('emails').select('id, thread_id, received_at').eq('account', accountEmail).eq('status', 'unreplied');
    if (!pending?.length) return;

    for (const email of pending) {
      if (!email.thread_id) continue;
      try {
        const thread = await gmail.users.threads.get({ userId: 'me', id: email.thread_id, format: 'metadata' });
        const messages = thread.data.messages || [];
        const receivedAtMs = new Date(email.received_at).getTime();
        const hasReply = messages.some(m => {
          const isSent = (m.labelIds || []).includes('SENT');
          const msgDateMs = parseInt(m.internalDate || '0');
          return isSent && msgDateMs > receivedAtMs;
        });
        if (hasReply) {
          await supabase.from('emails').update({ status: 'replied', replied_at: new Date().toISOString() }).eq('id', email.id);
        }
      } catch (err) {}
    }
  } catch (err) {
    console.error(`[Gmail] Reply check error:`, err.message);
  }
}

async function runGmailFetcher() {
  const { data: users } = await supabase.from('users').select('account_email, gmail_token').not('gmail_token', 'is', null);
  const envAccounts = (process.env.GMAIL_ACCOUNTS || '').split(',').map(e => e.trim()).filter(Boolean);
  const allAccounts = [...new Set([...(users || []).map(u => u.account_email), ...envAccounts])];
  
  if (!allAccounts.length) return;

  for (const account of allAccounts) {
    const tokens = await getTokenFromSupabase(account);
    if (!tokens) continue;
    
    await fetchGmailEmails(account);
    
    const oauth2Client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    await checkPendingReplies(account, gmail);
  }
}

async function runReplyCheckOnly() {
  const { data: users } = await supabase.from('users').select('account_email, gmail_token').not('gmail_token', 'is', null);
  if (!users?.length) return;
  
  for (const user of users) {
    const tokens = await getTokenFromSupabase(user.account_email);
    if (!tokens) continue;
    
    const oauth2Client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    await checkPendingReplies(user.account_email, gmail);
  }
}

module.exports = { runGmailFetcher, saveTokenToSupabase, runReplyCheckOnly };
