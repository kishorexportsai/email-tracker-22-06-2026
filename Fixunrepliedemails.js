// fixUnrepliedEmails.js
// Scans ONLY emails currently marked 'unreplied' and reclassifies
// internal / system / notification-only ones. No AI call — pure rule-based,
// so no rate limits, no delays, runs in seconds.
//
// Run: node fixUnrepliedEmails.js
// Delete after running.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Same detection logic as gmailFetcher.js ──────────────────────

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

const OBVIOUS_SYSTEM_DOMAINS = [
  'railway.app', 'github.com', 'github.io', 'render.com', 'vercel.app',
  'google.com', 'googlemail.com', 'linkedin.com', 'twitter.com',
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

const OBVIOUS_SYSTEM_KEYWORDS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'billing', 'invoice', 'receipt',
  'notification', 'alert', 'automated',
];

function isObviouslySystem(senderEmail) {
  const lower = (senderEmail || '').toLowerCase();
  const domain = lower.split('@')[1] || '';
  if (OBVIOUS_SYSTEM_DOMAINS.some(d => domain.includes(d))) return true;
  if (OBVIOUS_SYSTEM_KEYWORDS.some(k => lower.includes(k))) return true;
  return false;
}

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

// ──────────────────────────────────────────────────────────────────

async function fixUnrepliedEmails() {
  console.log('[Fix] Fetching all emails with status = unreplied...\n');

  const { data: emails, error } = await supabase
    .from('emails')
    .select('id, sender_email, sender_name, subject, body_preview, status')
    .eq('status', 'unreplied');

  if (error) {
    console.error('[Fix] Query error:', error.message);
    return;
  }

  if (!emails?.length) {
    console.log('[Fix] No unreplied emails found.');
    return;
  }

  console.log(`[Fix] Found ${emails.length} unreplied emails. Checking each...\n`);

  let internalCount = 0;
  let noReplyCount = 0;
  let leftAlone = 0;

  for (const email of emails) {
    let newStatus = null;
    let newReason = null;

    if (isInternalEmail(email.sender_email, email.sender_name)) {
      newStatus = 'internal';
      newReason = 'Internal Kishor email (auto-detect, rescanned)';
    } else {
      const bodyDetection = detectByBodyContent(email.body_preview);
      if (bodyDetection) {
        newStatus = bodyDetection.status;
        newReason = bodyDetection.reason + ' (rescanned)';
      } else if (isObviouslySystem(email.sender_email)) {
        newStatus = 'no_reply_needed';
        newReason = 'Auto-detected: system/bank email (rescanned)';
      }
    }

    if (newStatus) {
      const { error: upError } = await supabase
        .from('emails')
        .update({
          status: newStatus,
          ai_reason: newReason,
          ai_confidence: 'high',
          is_system_generated: newStatus === 'no_reply_needed',
          updated_at: new Date().toISOString()
        })
        .eq('id', email.id);

      if (upError) {
        console.log(`  [ERR] ${email.subject.slice(0, 50)}: ${upError.message}`);
      } else {
        console.log(`  [unreplied → ${newStatus}] ${email.subject.slice(0, 50)} (${email.sender_email})`);
        if (newStatus === 'internal') internalCount++;
        else noReplyCount++;
      }
    } else {
      leftAlone++;
    }
  }

  console.log(`\n[Fix] ✅ DONE!`);
  console.log(`  Moved to Internal: ${internalCount}`);
  console.log(`  Moved to No Reply Needed: ${noReplyCount}`);
  console.log(`  Left as genuinely unreplied: ${leftAlone}`);
  console.log(`  Total scanned: ${emails.length}`);
}

fixUnrepliedEmails().catch(console.error);
