// backend/gmailFetcher.js - BUYER-ALLOWLIST + INTERNAL-PATTERN VERSION
//
// Two independent, DB-configurable lists (see migration_domain_tables.sql):
//   tracked_buyer_domains  -> strict domain equality. Drives buyer unreplied/reminders/KPIs.
//   internal_identifiers   -> substring match against email+name. Drives Internal Mails tab.
//                             Kept as substring (not domain-only) because real internal senders
//                             include gmail.com accounts like kishor.merchant24@gmail.com —
//                             a domain-only table would miss those entirely.
//
// Any email whose sender matches NEITHER list is not inserted into the emails table at all.
// This is intentional: buyer tracking is scoped to known accounts, onboarding a new buyer
// means adding a row to tracked_buyer_domains, not a code change.
//
// Still retained from prior fixes:
//   - 5-day rolling fetch window (only tracks last 5 days)
//   - Auto-cleanup: deletes emails older than 5 days
//   - skip-if-exists dedup before any classification/AI/insert work
//   - reply-check scoped to status='unreplied' rows only, one thread.get() per pending row
//     (no bulk 500-message SENT scan)
//   - AI classification only reached for buyer-domain emails that aren't already resolved
//     by BCC/CC/body-detection/system-domain checks — retry+backoff on 429

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { classifyEmail } = require('./aiClassifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── SYSTEM/NOISE DETECTION (still applies within buyer-domain mail —
//    a buyer's own automated notification should still route to no_reply_needed) ──
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

// ── LOAD THE TWO CONFIGURABLE LISTS (once per run, not per message/account) ──
async function loadDomainConfig() {
  const [buyerRes, internalRes, keywordRes] = await Promise.all([
    supabase.from('tracked_buyer_domains').select('domain').eq('active', true),
    supabase.from('internal_identifiers').select('pattern').eq('active', true),
    supabase.from('tracked_keywords').select('keyword').eq('active', true),
  ]);

  if (buyerRes.error) {
    console.error('[Config] Failed to load tracked_buyer_domains:', buyerRes.error.message);
  }
  if (internalRes.error) {
    console.error('[Config] Failed to load internal_identifiers:', internalRes.error.message);
  }
  if (keywordRes.error) {
    console.error('[Config] Failed to load tracked_keywords:', keywordRes.error.message);
  }

  const buyerDomains = new Set((buyerRes.data || []).map(r => r.domain.toLowerCase()));
  const internalPatterns = (internalRes.data || []).map(r => r.pattern.toLowerCase());
  const trackedKeywords = (keywordRes.data || []).map(r => r.keyword.toLowerCase());

  if (buyerDomains.size === 0) {
    console.warn('[Config] WARNING: tracked_buyer_domains is empty — no buyer emails will be tracked this cycle.');
  }
  if (internalPatterns.length === 0) {
    console.warn('[Config] WARNING: internal_identifiers is empty — Internal Mails tab will get nothing this cycle.');
  }

  return { buyerDomains, internalPatterns, trackedKeywords };
}

// Word-boundary match against subject, body, and sender email/name —
// NOT plain substring, so 'pop' won't match inside 'population'.
// Multi-word keywords like 'green cotton' still work since \b anchors on both ends.
function matchesTrackedKeyword(subject, bodySnippet, senderEmail, senderName, trackedKeywords) {
  const haystack = `${subject || ''} ${bodySnippet || ''} ${senderEmail || ''} ${senderName || ''}`.toLowerCase();
  return trackedKeywords.some(kw => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    return re.test(haystack);
  });
}

function isInternalEmail(senderEmail, senderName, internalPatterns) {
  const emailLower = (senderEmail || '').toLowerCase();
  const nameLower = (senderName || '').toLowerCase();
  return internalPatterns.some(p => emailLower.includes(p) || nameLower.includes(p));
}

function isBuyerDomain(senderEmail, buyerDomains) {
  const domain = (senderEmail || '').toLowerCase().split('@')[1] || '';
  return buyerDomains.has(domain);
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

// ── FETCH: buyer domains + internal patterns, everything else ignored ──
async function fetchGmailEmails(accountEmail, domainConfig) {
  const { buyerDomains, internalPatterns, trackedKeywords } = domainConfig;

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
    // ═══ 5-DAY WINDOW ═══
    // Only fetch emails from the last 5 days
    const windowStart = new Date(Date.now() - (5 * 24 * 60 * 60 * 1000));
    const after = Math.floor(windowStart.getTime() / 1000);

    // NOT narrowing this query to from:(buyer domains) server-side — Gmail's from:
    // operator behavior on substring internal patterns isn't reliably documented,
    // and mixing exact-domain (buyer) with substring (internal) filters in one query
    // risks silent gaps. Filtering happens client-side after listing instead.
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 300,
      labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
      q: `after:${after}`
    });

    const messages = listRes.data.messages || [];
    console.log(`[Gmail] ${accountEmail}: ${messages.length} messages in 5-day window`);

    if (!messages.length) return 0;

    // Skip-if-exists: batched check before any per-message work
    const messageIds = messages.map(m => m.id);
    const { data: existing } = await supabase
      .from('emails')
      .select('email_id')
      .in('email_id', messageIds);

    const existingIds = new Set((existing || []).map(e => e.email_id));
    const newMessages = messages.filter(m => !existingIds.has(m.id));

    console.log(`[Gmail] ${accountEmail}: ${newMessages.length} new, ${existingIds.size} already saved (skipped)`);

    if (!newMessages.length) return 0;

    let saved = 0;
    let ignoredNonTracked = 0;

    for (const msg of newMessages) {
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

      // ── GATE: ONLY track the 15 specific tracked emails ──
      // The 15 emails are in internal_identifiers table but should be treated as BUYER emails
      // (shown in unreplied tab), not internal emails.
      const isTrackedEmail = isInternalEmail(senderEmail, senderName, internalPatterns);

      if (!isTrackedEmail) {
        ignoredNonTracked++;
        continue; // not inserted at all — not a tracked email
      }

      let status;
      let aiReason = null;
      let aiConfidence = null;

      // All tracked emails are treated as BUYER emails (unreplied/replied/no_reply_needed)
      // NOT as internal emails
      {
        // Buyer-domain email — still run noise checks, a buyer's own
        // automated system mail shouldn't count as a pending reply
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

        status = 'unreplied';

        if (isBcc) {
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
          aiReason = 'Auto-detected: system/bulk email';
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

    console.log(`[Gmail] ${accountEmail}: ${saved} saved (buyer+internal), ${ignoredNonTracked} ignored (untracked domain)`);
    return saved;

  } catch (err) {
    console.error(`[Gmail] Error for ${accountEmail}:`, err.message);
    return 0;
  }
}

// ── REPLY CHECK: only buyer emails still status='unreplied' ─────
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
      console.log(`[Gmail] ${accountEmail}: no pending buyer emails to check`);
      return;
    }

    console.log(`[Gmail] ${accountEmail}: checking ${pending.length} pending buyer threads`);

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

// ── AUTO-CLEANUP: Delete emails older than 5 days ──────────────────
async function cleanupOldEmails() {
  try {
    const cutoffDate = new Date(Date.now() - (5 * 24 * 60 * 60 * 1000)).toISOString();
    const { error } = await supabase
      .from('emails')
      .delete()
      .lt('received_at', cutoffDate);

    if (error) {
      console.error('[Gmail] Cleanup error:', error.message);
    } else {
      console.log('[Gmail] Cleanup complete: deleted emails older than 5 days');
    }
  } catch (err) {
    console.error('[Gmail] Cleanup failed:', err.message);
  }
}

// ── MAIN ─────────────────────────────────────────────────────────
async function runGmailFetcher() {
  const domainConfig = await loadDomainConfig();

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

    await fetchGmailEmails(account, domainConfig);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    await checkPendingReplies(account, gmail);
  }

  // Auto-cleanup: delete emails older than 5 days
  await cleanupOldEmails();

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

module.exports = { runGmailFetcher, saveTokenToSupabase, runReplyCheckOnly, loadDomainConfig };
