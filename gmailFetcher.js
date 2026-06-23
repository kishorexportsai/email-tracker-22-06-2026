// backend/gmailFetcher.js
require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { classifyEmail } = require('./aiClassifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── QUICK PRE-FILTER (saves AI API calls for obvious junk) ────────
const OBVIOUS_SYSTEM_DOMAINS = [
  'railway.app', 'github.com', 'github.io',
  'google.com', 'accounts.google.com', 'googlemail.com',
  'linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'mailchimp.com', 'sendgrid.net', 'amazonses.com',
  'hdfcbank.com', 'sbi.co.in', 'icicibank.com', 'axisbank.com',
  'kotak.com', 'yesbank.in', 'paytm.com', 'phonepe.com',
  'indiamart.com', 'tradeindia.com', 'alibaba.com',
  'apollo.io', 'vultr.com', 'anthropic.com', 'dyad.sh',
  'stripe.com', 'paypal.com', 'razorpay.com',
  'zoom.us', 'slack.com', 'notion.so',
];

const OBVIOUS_SYSTEM_KEYWORDS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster',
];

const GMAIL_LABELS_TO_SKIP = ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'SPAM'];

function isObviouslySystem(senderEmail, labelIds, listUnsub) {
  if (listUnsub) return true; // has List-Unsubscribe header = bulk mail
  if (labelIds.some(l => GMAIL_LABELS_TO_SKIP.includes(l))) return true;
  const lower = (senderEmail || '').toLowerCase();
  const domain = lower.split('@')[1] || '';
  if (OBVIOUS_SYSTEM_DOMAINS.some(d => domain.includes(d))) return true;
  if (OBVIOUS_SYSTEM_KEYWORDS.some(k => lower.includes(k))) return true;
  return false;
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// ── TOKEN STORAGE ─────────────────────────────────────────────────
async function getTokenFromSupabase(accountEmail) {
  const { data, error } = await supabase
    .from('users').select('gmail_token').eq('email', accountEmail).single();
  if (error || !data?.gmail_token) {
    console.log(`[Gmail] No token for ${accountEmail}`);
    return null;
  }
  try {
    return typeof data.gmail_token === 'string' ? JSON.parse(data.gmail_token) : data.gmail_token;
  } catch { return null; }
}

async function saveTokenToSupabase(accountEmail, tokens) {
  const { error } = await supabase
    .from('users').update({ gmail_token: JSON.stringify(tokens) }).eq('email', accountEmail);
  if (error) console.error(`[Gmail] Failed to save token for ${accountEmail}:`, error.message);
}

// ── FETCH EMAILS FOR ONE ACCOUNT ─────────────────────────────────
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
    console.log(`[Gmail] Token refreshed for ${accountEmail}`);
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // Fetch only last 5 days of emails
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const after = Math.floor(fiveDaysAgo.getTime() / 1000);
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 500,
      labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
      q: `after:${after}`
    });
    const messages = listRes.data.messages || [];

    console.log(`[Gmail] ${accountEmail}: ${messages.length} messages found`);
    let saved = 0;

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'List-Unsubscribe']
      });

      const headers = detail.data.payload?.headers || [];
      const labelIds = detail.data.labelIds || [];
      const from = getHeader(headers, 'From');
      const toHeader = getHeader(headers, 'To');
      const ccHeader = getHeader(headers, 'Cc');
      const subject = getHeader(headers, 'Subject') || '(No Subject)';
      const date = getHeader(headers, 'Date');
      const listUnsub = getHeader(headers, 'List-Unsubscribe');

      const emailMatch = from.match(/<(.+)>/);
      const senderEmail = emailMatch ? emailMatch[1] : from;
      const senderName = from.replace(/<.+>/, '').trim().replace(/"/g, '');

      const receivedAt = date ? new Date(date).toISOString() : new Date().toISOString();

      // Only AI-classify emails from the last 15 days
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const isRecent = new Date(receivedAt).getTime() > fifteenDaysAgo;

      // ── INTERNAL EMAIL DETECTION ──────────────────────────────────
      const INTERNAL_DOMAINS = ['kishorexports.com', 'kishorexports.ai'];
      const INTERNAL_KEYWORDS = ['kishor.merchant', 'kishorexports', 'kishor.exports'];
      const senderLower = senderEmail.toLowerCase();
      const isInternal = INTERNAL_DOMAINS.some(d => senderLower.includes(d)) ||
                         INTERNAL_KEYWORDS.some(k => senderLower.includes(k));

      // ── BCC DETECTION ─────────────────────────────────────────────
      // If our account email is NOT in To or CC, we were BCC'd → no reply needed
      const accountLower = accountEmail.toLowerCase();
      const inTo = toHeader.toLowerCase().includes(accountLower);
      const inCc = ccHeader.toLowerCase().includes(accountLower);
      const isBcc = !inTo && !inCc;

      // ── CC + AMIT CHECK ───────────────────────────────────────────
      // If we're CC'd (not in To) and "amit" is not in the body snippet → no reply needed
      const isOnlyCc = !inTo && inCc;
      const bodySnippet = (detail.data.snippet || '').toLowerCase();
      const amitMentioned = bodySnippet.includes('amit');
      const ccNoAmit = isOnlyCc && !amitMentioned;

      // Step 1: quick check for obvious system emails (no AI call needed)
      const obviouslySystem = isObviouslySystem(senderEmail, labelIds, listUnsub.length > 0);

      let status = 'unreplied';
      let aiReason = null;
      let aiConfidence = null;

      if (isInternal) {
        status = 'internal';
        aiReason = 'Internal Kishor email';
        aiConfidence = 'high';
      } else if (isBcc) {
        status = 'no_reply_needed';
        aiReason = 'BCC only — no reply needed';
        aiConfidence = 'high';
      } else if (ccNoAmit) {
        status = 'no_reply_needed';
        aiReason = 'CC only and Amit not mentioned — FYI email';
        aiConfidence = 'high';
      } else if (obviouslySystem) {
        status = 'no_reply_needed';
        aiReason = 'Auto-detected: system/bulk/bank email';
        aiConfidence = 'high';
      } else if (isRecent) {
        // Step 2: AI classification only for last 15 days
        const bodyPreview = detail.data.snippet || ''; // already in bodySnippet but kept for clarity
        const aiResult = await classifyEmail({
          senderEmail, senderName, subject, bodyPreview,
          toHeader, ccHeader, accountEmail
        });

        if (aiResult) {
          status = aiResult.needs_reply ? 'unreplied' : 'no_reply_needed';
          aiReason = aiResult.reason;
          aiConfidence = aiResult.confidence;
        }
        // Rate limit: wait 4 seconds between Gemini calls (free tier = 15 RPM)
        await new Promise(r => setTimeout(r, 4000));
        // if AI fails → default stays 'unreplied' (safe fallback)
      }
      // older than 15 days → save as 'unreplied' without AI (you can review manually)

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

      const { error } = await supabase
        .from('emails')
        .upsert(emailData, { onConflict: 'email_id', ignoreDuplicates: true });

      if (!error) saved++;
    }

    console.log(`[Gmail] ${accountEmail}: ${saved} saved`);
    await checkGmailReplies(accountEmail, gmail);
    return saved;

  } catch (err) {
    console.error(`[Gmail] Error for ${accountEmail}:`, err.message);
    return 0;
  }
}

// ── AI RESCAN: re-classify existing emails ────────────────────────
async function aiRescanExistingEmails() {
  console.log('[AI Rescan] Starting bulk re-classification...');

  const { data: emails, error } = await supabase
    .from('emails')
    .select('id, sender_email, sender_name, subject, body_preview, account')
    .eq('status', 'unreplied')
    .order('received_at', { ascending: false });

  if (error || !emails?.length) {
    console.log('[AI Rescan] No unreplied emails found or error:', error?.message);
    return { scanned: 0, changed: 0 };
  }

  console.log(`[AI Rescan] Scanning ${emails.length} emails...`);
  let changed = 0;

  for (const email of emails) {
    const obviouslySystem = isObviouslySystem(email.sender_email, [], false);
    const senderLower = (email.sender_email || '').toLowerCase();
    const isInternalEmail = ['kishorexports.com', 'kishorexports.ai'].some(d => senderLower.includes(d)) ||
                            ['kishor.merchant', 'kishorexports', 'kishor.exports'].some(k => senderLower.includes(k));

    let status = 'unreplied';
    let aiReason = null;
    let aiConfidence = null;

    if (isInternalEmail) {
      status = 'internal';
      aiReason = 'Internal Kishor email';
      aiConfidence = 'high';
    } else if (obviouslySystem) {
      status = 'no_reply_needed';
      aiReason = 'Auto-detected: system/bulk/bank email';
      aiConfidence = 'high';
    } else {
      const aiResult = await classifyEmail({
        senderEmail: email.sender_email,
        senderName: email.sender_name,
        subject: email.subject,
        bodyPreview: email.body_preview,
        toHeader: '',
        ccHeader: '',
        accountEmail: email.account
      });

      if (aiResult && !aiResult.needs_reply) {
        status = 'no_reply_needed';
        aiReason = aiResult.reason;
        aiConfidence = aiResult.confidence;
      }
      // Rate limit: 4s delay between Gemini calls
      await new Promise(r => setTimeout(r, 4000));
    }

    if (status === 'no_reply_needed' || status === 'internal') {
      await supabase
        .from('emails')
        .update({
          status: status,
          is_system_generated: status === 'no_reply_needed',
          ai_reason: aiReason,
          ai_confidence: aiConfidence,
          updated_at: new Date().toISOString()
        })
        .eq('id', email.id);
      changed++;
    }

  }

  console.log(`[AI Rescan] Done. ${changed}/${emails.length} reclassified as no_reply_needed`);
  return { scanned: emails.length, changed };
}

// ── CHECK REPLIES ─────────────────────────────────────────────────
async function checkGmailReplies(accountEmail, gmail) {
  try {
    const sinceMs = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days

    const sentRes = await gmail.users.messages.list({
      userId: 'me', maxResults: 500, labelIds: ['SENT'],
    });

    const sentMessages = sentRes.data.messages || [];
    if (!sentMessages.length) return;

    const threadIds = [];
    const sentToEmails = []; // { email, sentAt, subject }

    for (const msg of sentMessages.slice(0, 500)) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['To', 'Subject', 'Date']
      });
      const internalDate = parseInt(detail.data.internalDate || '0');
      if (internalDate > sinceMs && detail.data.threadId) {
        threadIds.push(detail.data.threadId);

        const headers = detail.data.payload?.headers || [];
        const toHeader = headers.find(h => h.name === 'To')?.value || '';
        const subjectHeader = headers.find(h => h.name === 'Subject')?.value || '';
        const cleanSubject = subjectHeader.replace(/^(re|fw|fwd|sv|reg|vs|vb|ang|tr):\s*/gi, '').trim().toLowerCase();

        const emailMatches = toHeader.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
        for (const em of emailMatches) {
          sentToEmails.push({ email: em.toLowerCase(), sentAt: internalDate, subject: cleanSubject });
        }
      }
    }

    // ── Thread ID matching (existing logic) ──
    if (threadIds.length) {
      const { data: unreplied } = await supabase
        .from('emails')
        .select('id')
        .eq('account', accountEmail)
        .eq('status', 'unreplied')
        .in('thread_id', threadIds);

      if (unreplied?.length) {
        const ids = unreplied.map(e => e.id);
        await supabase.from('emails').update({
          status: 'replied',
          replied_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).in('id', ids);
        console.log(`[Gmail] ${accountEmail}: ${ids.length} marked replied via thread`);
      }
    }

    // ── Sender-based matching (new email replies) ──
    if (sentToEmails.length) {
      const { data: unrepliedEmails } = await supabase
        .from('emails')
        .select('id, sender_email, received_at, subject')
        .eq('account', accountEmail)
        .eq('status', 'unreplied')
        .gte('received_at', new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString());

      if (unrepliedEmails?.length) {
        const toMarkReplied = [];
        for (const email of unrepliedEmails) {
          const senderLower = (email.sender_email || '').toLowerCase();
          const receivedAt = new Date(email.received_at).getTime();
          const emailSubject = (email.subject || '').replace(/^(re|fw|fwd|sv|reg|vs|vb|ang|tr):\s*/gi, '').trim().toLowerCase();

          // Match: sent TO same person + same subject (ignoring RE/FW) within 7 days
          const replied = sentToEmails.some(sent =>
            sent.email === senderLower &&
            sent.sentAt > receivedAt &&
            sent.sentAt < receivedAt + 7 * 24 * 60 * 60 * 1000 &&
            (sent.subject === emailSubject || sent.subject.includes(emailSubject) || emailSubject.includes(sent.subject))
          );
          if (replied) toMarkReplied.push(email.id);
        }

        if (toMarkReplied.length) {
          await supabase.from('emails').update({
            status: 'replied',
            replied_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }).in('id', toMarkReplied);
          console.log(`[Gmail] ${accountEmail}: ${toMarkReplied.length} marked replied via sender match`);
        }
      }
    }

    // ── Internal email reply matching ──
    if (sentToEmails.length) {
      const { data: internalEmails } = await supabase
        .from('emails')
        .select('id, sender_email, received_at, subject')
        .eq('account', accountEmail)
        .eq('status', 'internal')
        .gte('received_at', new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString());

      if (internalEmails?.length) {
        const toMarkInternalReplied = [];
        for (const email of internalEmails) {
          const senderLower = (email.sender_email || '').toLowerCase();
          const receivedAt = new Date(email.received_at).getTime();
          const emailSubject = (email.subject || '').replace(/^(re|fw|fwd|sv|reg|vs|vb|ang|tr):\s*/gi, '').trim().toLowerCase();

          const replied = sentToEmails.some(sent =>
            sent.email === senderLower &&
            sent.sentAt > receivedAt &&
            sent.sentAt < receivedAt + 7 * 24 * 60 * 60 * 1000 &&
            (sent.subject === emailSubject || sent.subject.includes(emailSubject) || emailSubject.includes(sent.subject))
          );
          if (replied) toMarkInternalReplied.push(email.id);
        }

        if (toMarkInternalReplied.length) {
          await supabase.from('emails').update({
            status: 'internal_replied',
            replied_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }).in('id', toMarkInternalReplied);
          console.log(`[Gmail] ${accountEmail}: ${toMarkInternalReplied.length} internal emails marked replied`);
        }
      }
    }

  } catch (err) {
    console.error(`[Gmail] Reply check error for ${accountEmail}:`, err.message);
  }
}

// ── MAIN ──────────────────────────────────────────────────────────
async function runGmailFetcher() {
  const { data: users, error } = await supabase
    .from('users').select('email, gmail_token').not('gmail_token', 'is', null);

  if (error) { console.error('[Gmail] Supabase error:', error.message); return; }

  const envAccounts = (process.env.GMAIL_ACCOUNTS || '').split(',').map(e => e.trim()).filter(Boolean);
  const allAccounts = [...new Set([...(users || []).map(u => u.email), ...envAccounts])];

  if (!allAccounts.length) { console.log('[Gmail] No connected accounts'); return; }

  console.log(`[Gmail] Fetching ${allAccounts.length} accounts`);
  for (const account of allAccounts) await fetchGmailEmails(account);
  console.log('[Gmail] Done.');
}

async function runReplyCheckOnly() {
  const { data: users } = await supabase.from('users').select('email, gmail_token').not('gmail_token', 'is', null);
  const envAccounts = (process.env.GMAIL_ACCOUNTS || '').split(',').map(e => e.trim()).filter(Boolean);
  const allAccounts = [...new Set([...(users || []).map(u => u.email), ...envAccounts])];
  if (!allAccounts.length) return;
  console.log(`[Gmail] Reply-check-only for ${allAccounts.length} accounts`);
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
    await checkGmailReplies(account, gmail);
  }
  console.log('[Gmail] Reply-check-only done.');
}

module.exports = { runGmailFetcher, saveTokenToSupabase, aiRescanExistingEmails, runReplyCheckOnly };
