require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { classifyEmail } = require('./aiClassifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// === 15 TRACKED SENDERS ONLY ===
const TRACKED = new Set([
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

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

async function getToken(email) {
  const { data } = await supabase.from('users').select('gmail_token').eq('account_email', email).single();
  if (!data?.gmail_token) return null;
  try {
    return typeof data.gmail_token === 'string' ? JSON.parse(data.gmail_token) : data.gmail_token;
  } catch {
    return null;
  }
}

async function saveToken(email, tokens) {
  await supabase.from('users').update({ gmail_token: JSON.stringify(tokens) }).eq('account_email', email);
}

async function fetchEmails(email) {
  const tokens = await getToken(email);
  if (!tokens) return 0;

  const oauth2Client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => saveToken(email, { ...tokens, ...newTokens }));

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // === LAST 5 DAYS ONLY ===
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const afterDate = fiveDaysAgo.toISOString().split('T')[0];
    const query = `in:inbox after:${afterDate}`;

    console.log(`[Gmail] Fetching ${email} - last 5 days only`);

    const { data: messages_result } = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 500 });
    const messages = messages_result?.messages || [];

    if (!messages.length) {
      console.log(`[Gmail] No emails for ${email}`);
      return 0;
    }

    let saved = 0;
    let skipped = 0;

    for (const msg of messages) {
      const { data: exists } = await supabase.from('emails').select('id').eq('email_id', msg.id).single();
      if (exists) continue;

      const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.payload?.headers || [];
      const fromHeader = getHeader(headers, 'From') || '';

      // Extract email
      let sender = '';
      const match = fromHeader.match(/<(.+?)>/);
      if (match && match[1]) {
        sender = match[1].toLowerCase().trim();
      } else {
        sender = fromHeader.toLowerCase().trim();
      }

      // === CHECK IF TRACKED ===
      if (!TRACKED.has(sender)) {
        skipped++;
        continue;
      }

      console.log(`[Gmail] TRACKED: ${sender}`);
      saved++;

      const subject = getHeader(headers, 'Subject') || '(No Subject)';
      const receivedAt = new Date(getHeader(headers, 'Date') || Date.now()).toISOString();

      await supabase.from('emails').insert({
        email_id: msg.id,
        thread_id: full.threadId,
        account: email,
        source: 'gmail',
        sender_name: fromHeader.split('<')[0].trim(),
        sender_email: sender,
        subject: subject,
        body_preview: full.snippet || '',
        email_link: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
        received_at: receivedAt,
        status: 'unreplied',
        is_system_generated: false,
        ai_reason: '',
        ai_confidence: 'medium',
      });
    }

    console.log(`[Gmail] DONE: ${saved} saved, ${skipped} skipped`);
    return saved;

  } catch (err) {
    console.error(`[Gmail] Error:`, err.message);
    return 0;
  }
}

async function checkReplies(email) {
  const tokens = await getToken(email);
  if (!tokens) return;

  const oauth2Client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    const { data: pending } = await supabase.from('emails').select('id, thread_id, received_at').eq('account', email).eq('status', 'unreplied');
    if (!pending?.length) return;

    for (const p of pending) {
      if (!p.thread_id) continue;
      try {
        const { data: thread } = await gmail.users.threads.get({ userId: 'me', id: p.thread_id, format: 'metadata' });
        const msgs = thread.messages || [];
        const receivedTime = new Date(p.received_at).getTime();

        const hasReply = msgs.some(m => {
          const isSent = (m.labelIds || []).includes('SENT');
          const msgTime = parseInt(m.internalDate || '0');
          return isSent && msgTime > receivedTime;
        });

        if (hasReply) {
          await supabase.from('emails').update({ status: 'replied', replied_at: new Date().toISOString() }).eq('id', p.id);
        }
      } catch (e) {}
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

  console.log(`[Gmail] Starting fetch for ${allAccounts.length} accounts`);

  for (const account of allAccounts) {
    await fetchEmails(account);
    await checkReplies(account);
  }

  console.log(`[Gmail] Complete`);
}

async function runReplyCheckOnly() {
  const { data: users } = await supabase.from('users').select('account_email, gmail_token').not('gmail_token', 'is', null);
  for (const user of users || []) {
    await checkReplies(user.account_email);
  }
}

module.exports = { runGmailFetcher, saveToken, runReplyCheckOnly };
