// backend/gmailFetcher.js - FINAL (rate-limit hardened)
// Changes from previous version:
// 1. classifyEmailSafe() wraps classifyEmail with retry + exponential backoff on 429
// 2. Delay between AI calls raised 4000ms -> 5000ms (12 RPM vs Gemini's 15 RPM cap, leaves margin)
// 3. On repeated 429 after retries, falls through to existing safe default (status stays 'unreplied')
//    instead of hammering the API pointlessly

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { classifyEmail } = require('./aiClassifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── SYSTEM DOMAIN DETECTION ──────────────────────────────────────
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

const INTERNAL_DOMAINS = ['kishorexports.com', 'kishorexports.ai'];

function isInternalEmail(senderEmail, senderName) {
  const emailLower = (senderEmail || '').toLowerCase();
  const nameLower = (senderName || '').toLowerCase();
  const domain = emailLower.split('@')[1] || '';
  if (INTERNAL_DOMAINS.some(d => domain.includes(d))) return true;
  if (emailLower.includes('kishor')) return true;
  if (nameLower.includes('kishor')) return true;
  return false;
}

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

// ── AI CALL WITH RETRY + BACKOFF (handles 429) ───────────────────
async function classifyEmailSafe(params, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await classifyEmail(params);
      return result;
    } catch (err) {
      const is429 = err?.status === 429 || err?.message?.includes('429');
      const isLast = attempt === maxRetries;

      if (!is429 || isLast) {
        console.error(`[AI] Failed (attempt ${attempt + 1}/${maxRetries + 1}):`, err.message);
        return null; // fall through to safe default (unreplied) at call site
      }

      // Exponential backoff: 5s, 10s, 20s
      const backoffMs = 5000 * Math.pow(2, attempt);
      console.log(`[AI] Rate limited (429). Retrying in ${backoffMs / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  return null;
}

// ── TOKEN STORAGE ─────────────────────────────────────────────────
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

// ── FETCH EMAILS ─────────────────────────────────────────────────
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
        userId: 'me',
        id: msg.id,
        format: 'metadata',
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
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const isRecent = new Date(receivedAt).getTime() > fifteenDaysAgo;

      const isInternal = isInternalEmail(senderEmail, senderName);

      const accountLower = accountEmail.toLowerCase();
      const inTo = toHeader.toLowerCase().includes(accountLower);
      const inCc = ccHeader.toLowerCase().includes(accountLower);
      const isBcc = !inTo && !inCc;

      const isOnlyCc = !inTo && inCc;
      const bodySnippet = (detail.data.snippet || '').toLowerCase();
      const amitMentioned = bodySnippet.includes('amit');
      const ccNoAmit = isOnlyCc && !amitMentioned;

      const obviouslySystem = isObviouslySystem(senderEmail, labelIds, listUnsub.length > 0);
      const bodyDetection = detectByBodyContent(detail.data.snippet);

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
      } else if (bodyDetection) {
        status = bodyDetection.status;
        aiReason = bodyDetection.reason;
        aiConfidence = 'high';
      } else if (obviouslySystem) {
        status = 'no_reply_needed';
        aiReason = 'Auto-detected: system/bulk/bank email';
        aiConfidence = 'high';
      } else if (isRecent) {
        // Only reaches here for genuinely ambiguous emails —
        // everything else already resolved above
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
        // else: aiResult is null (failed after retries) -> stays 'unreplied', safe default

        // 5s base delay = 12 RPM, under Gemini free tier's 15 RPM cap
        await new Promise(r => setTimeout(r, 5000));
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

      const { error } = await supabase
        .from('emails')
        .upsert(emailData, { onConflict: 'email_id' });

      if (!error) saved++;
    }

    console.log(`[Gmail] ${accountEmail}: ${saved} saved/updated`);
    await checkGmailReplies(accountEmail, gmail);
    return saved;

  } catch (err) {
    console.error(`[Gmail] Error for ${accountEmail}:`, err.message);
    return 0;
  }
}

// ── AI RESCAN ────────────────────────────────────────────────────
async function aiRescanExistingEmails() {
  console.log('[AI Rescan] Starting bulk re-classification...');

  const { data: emails, error } = await supabase
    .from('emails')
    .select('id, sender_email, sender_name, subject, body_preview, account, status')
    .eq('status', 'unreplied')
    .order('received_at', { ascending: false });

  if (error || !emails?.length) {
    console.log('[AI Rescan] No unreplied emails found');
    return { scanned: 0, changed: 0 };
  }

  console.log(`[AI Rescan] Processing ${emails.length} unreplied emails...`);
  let changed = 0;

  for (const email of emails) {
    const isInternal = isInternalEmail(email.sender_email, email.sender_name);
    const obviouslySystem = isObviouslySystem(email.sender_email, [], false);
    const bodyDetection = detectByBodyContent(email.body_preview);

    let newStatus = 'unreplied';
    let newReason = null;
    let newConfidence = null;

    if (isInternal) {
      newStatus = 'internal';
      newReason = 'Internal Kishor email';
      newConfidence = 'high';
    } else if (bodyDetection) {
      newStatus = bodyDetection.status;
      newReason = bodyDetection.reason;
      newConfidence = 'high';
    } else if (obviouslySystem) {
      newStatus = 'no_reply_needed';
      newReason = 'Auto-detected: system/bank email';
      newConfidence = 'high';
    } else {
      const aiResult = await classifyEmailSafe({
        senderEmail: email.sender_email,
        senderName: email.sender_name,
        subject: email.subject,
        bodyPreview: email.body_preview,
        toHeader: '',
        ccHeader: '',
        accountEmail: email.account
      });

      if (aiResult && !aiResult.needs_reply) {
        newStatus = 'no_reply_needed';
        newReason = aiResult.reason;
        newConfidence = aiResult.confidence;
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    if (newStatus !== email.status) {
      await supabase
        .from('emails')
        .update({
          status: newStatus,
          is_system_generated: newStatus === 'no_reply_needed',
          ai_reason: newReason,
          ai_confidence: newConfidence,
          updated_at: new Date().toISOString()
        })
        .eq('id', email.id);

      changed++;
      console.log(`  [${email.status} → ${newStatus}] ${email.subject.slice(0, 50)}`);
    }
  }

  console.log(`[AI Rescan] Done. ${changed}/${emails.length} reclassified`);
  return { scanned: emails.length, changed };
}

// ── CHECK REPLIES ────────────────────────────────────────────────
async function checkGmailReplies(accountEmail, gmail) {
  try {
    const sinceMs = Date.now() - 60 * 24 * 60 * 60 * 1000;

    const sentRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 500,
      labelIds: ['SENT'],
    });

    const sentMessages = sentRes.data.messages || [];
    if (!sentMessages.length) return;

    const threadIds = [];
    const sentToEmails = [];

    for (const msg of sentMessages.slice(0, 500)) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['To', 'Subject', 'Date']
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
        console.log(`[Gmail] ${accountEmail}: ${ids.length} marked replied (thread match)`);
      }
    }

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
          console.log(`[Gmail] ${accountEmail}: ${toMarkReplied.length} marked replied (sender match)`);
        }
      }
    }

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

// ── MAIN ─────────────────────────────────────────────────────────
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
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  const allAccounts = [...new Set([
    ...(users || []).map(u => u.account_email),
    ...envAccounts
  ])];

  if (!allAccounts.length) {
    console.log('[Gmail] No connected accounts');
    return;
  }

  console.log(`[Gmail] Fetching ${allAccounts.length} accounts`);
  // Sequential (not parallel) — keeps AI calls from stacking across accounts
  // and hitting the rate limit even harder
  for (const account of allAccounts) {
    await fetchGmailEmails(account);
  }
  console.log('[Gmail] Done.');
}

async function runReplyCheckOnly() {
  const { data: users } = await supabase
    .from('users')
    .select('account_email, gmail_token')
    .not('gmail_token', 'is', null);

  const envAccounts = (process.env.GMAIL_ACCOUNTS || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  const allAccounts = [...new Set([
    ...(users || []).map(u => u.account_email),
    ...envAccounts
  ])];

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
