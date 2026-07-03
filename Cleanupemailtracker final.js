// cleanupEmailTracker-FINAL.js
// Run ONCE: node cleanupEmailTracker-FINAL.js
// Then delete this file

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { classifyEmail } = require('./backend/aiClassifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── SAME DETECTION LOGIC AS gmailFetcher-FINAL.js ──────────────

const DO_NOT_REPLY_KEYWORDS = [
  'notification-only address',
  'do not reply',
  'do-not-reply',
  'cannot accept incoming',
  'no-reply',
  'noreply',
  'automated message',
  'automated response',
  'this is an automated',
  'please do not respond',
  'please do not reply',
  'do not respond to this',
  'mailer-daemon',
  'postmaster',
  'undeliverable',
  'out of office',
];

const FYI_KEYWORDS = [
  'for your information',
  'for information only',
  'for your reference',
  'fyi',
  'for awareness',
  'please note',
  'for your attention',
  'inward team has already sent',
  'already processed',
  'already handled',
  'in case you need',
  'status update',
  'information only',
  'tracking update',
  'shipment status',
  'order confirmation',
  'invoice attached',
  'attached invoice',
];

const INTERNAL_DOMAINS = ['kishorexports.com', 'kishorexports.ai'];
const OBVIOUS_SYSTEM_DOMAINS = [
  'railway.app', 'github.com', 'render.com', 'vercel.app',
  'google.com', 'googlemail.com', 'linkedin.com', 'twitter.com',
  'mailchimp.com', 'sendgrid.net', 'amazonses.com',
  'hdfcbank.com', 'sbi.co.in', 'icicibank.com', 'axisbank.com',
  'kotak.com', 'yesbank.in', 'canarabank.com', 'paytm.com',
  'razorpay.com', 'stripe.com', 'paypal.com', 'zoom.us',
  'slack.com', 'ul.com', 'ftncv.com', 'dhl.com', 'fedex.com'
];

function isInternalEmail(senderEmail, senderName) {
  const emailLower = (senderEmail || '').toLowerCase();
  const nameLower = (senderName || '').toLowerCase();
  const domain = emailLower.split('@')[1] || '';
  
  if (INTERNAL_DOMAINS.some(d => domain.includes(d))) return true;
  if (emailLower.includes('kishor')) return true;
  if (nameLower.includes('kishor')) return true;
  
  return false;
}

function isSystemEmail(senderEmail) {
  const lower = (senderEmail || '').toLowerCase();
  const domain = lower.split('@')[1] || '';
  
  return OBVIOUS_SYSTEM_DOMAINS.some(d => domain.includes(d)) ||
         lower.includes('noreply') || lower.includes('billing') || 
         lower.includes('invoice') || lower.includes('automated');
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

// ──────────────────────────────────────────────────────────────────

async function cleanupEmails() {
  console.log('[Cleanup] Starting email re-classification...\n');

  const { data: allEmails, error } = await supabase
    .from('emails')
    .select('*')
    .order('received_at', { ascending: false });

  if (error || !allEmails?.length) {
    console.log('[Cleanup] No emails found or error:', error?.message);
    return;
  }

  console.log(`[Cleanup] Found ${allEmails.length} total emails\n`);

  const seen = new Set();
  const toDelete = [];
  const toUpdate = [];
  let internalCount = 0;
  let noReplyCount = 0;
  let unrepliedCount = 0;

  // ── Step 1: Classify and find duplicates ──
  for (const email of allEmails) {
    // Check for duplicates
    if (seen.has(email.email_id)) {
      toDelete.push(email.id);
      console.log(`  [DUP] ${email.subject.slice(0, 40)}`);
      continue;
    }
    seen.add(email.email_id);

    let newStatus = email.status;
    let newReason = email.ai_reason;
    let newConfidence = email.ai_confidence;

    // 1. Internal check
    if (isInternalEmail(email.sender_email, email.sender_name)) {
      newStatus = 'internal';
      newReason = 'Internal Kishor email (auto-detect)';
      newConfidence = 'high';
      internalCount++;
    }
    // 2. Body content check (notification-only, FYI)
    else {
      const bodyDetection = detectByBodyContent(email.body_preview);
      if (bodyDetection) {
        newStatus = 'no_reply_needed';
        newReason = bodyDetection.reason;
        newConfidence = 'high';
        noReplyCount++;
      }
      // 3. System check
      else if (isSystemEmail(email.sender_email)) {
        newStatus = 'no_reply_needed';
        newReason = 'Auto-detected: system/bank email';
        newConfidence = 'high';
        noReplyCount++;
      } else {
        unrepliedCount++;
      }
    }

    // Track changes only if status changed
    if (newStatus !== email.status || newReason !== email.ai_reason) {
      toUpdate.push({
        id: email.id,
        oldStatus: email.status,
        newStatus,
        newReason,
        newConfidence,
        subject: email.subject.slice(0, 50),
        sender: email.sender_email
      });
    }
  }

  // ── Step 2: Delete duplicates ──
  if (toDelete.length) {
    console.log(`\n[Cleanup] Deleting ${toDelete.length} duplicate emails...`);
    const { error: delError } = await supabase
      .from('emails')
      .delete()
      .in('id', toDelete);
    
    if (delError) {
      console.error('[Cleanup] Delete error:', delError.message);
    } else {
      console.log(`[Cleanup] ✅ Deleted ${toDelete.length} duplicates\n`);
    }
  }

  // ── Step 3: Update re-classified emails ──
  if (toUpdate.length) {
    console.log(`[Cleanup] Re-classifying ${toUpdate.length} emails...\n`);
    
    for (const item of toUpdate) {
      const { error: upError } = await supabase
        .from('emails')
        .update({
          status: item.newStatus,
          ai_reason: item.newReason,
          ai_confidence: item.newConfidence,
          is_system_generated: item.newStatus === 'no_reply_needed',
          updated_at: new Date().toISOString()
        })
        .eq('id', item.id);

      if (upError) {
        console.log(`  [ERR] ${item.subject}: ${upError.message}`);
      } else {
        console.log(`  [${item.oldStatus} → ${item.newStatus}] ${item.subject} (${item.sender})`);
      }
    }
  }

  // ── Final stats ──
  console.log(`\n[Cleanup] ✅ DONE!\n`);
  console.log(`Email Breakdown:`);
  console.log(`  Internal: ${internalCount}`);
  console.log(`  No Reply Needed: ${noReplyCount}`);
  console.log(`  Unreplied (needs action): ${unrepliedCount}`);
  console.log(`  Duplicates deleted: ${toDelete.length}`);
  console.log(`  Reclassified: ${toUpdate.length}`);
}

cleanupEmails().catch(console.error);
