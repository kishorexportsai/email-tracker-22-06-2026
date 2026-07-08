// cleanupUntrackedEmails.js
// ONE-TIME script. Run once, then delete.
//
// Problem this fixes: gmailFetcher.js's buyer-allowlist/keyword gate only
// blocks NEW incoming mail from being inserted. It has no effect on rows
// already sitting in the emails table from before this gate existed.
// This script applies the exact same current gate logic against every
// existing row currently in status='unreplied' and removes anything that
// doesn't actually match internal_identifiers, tracked_buyer_domains, or
// tracked_keywords.
//
// This is destructive — non-matching rows are DELETED, not archived.
// If you want a safety net instead, change the DELETE block below to an
// UPDATE that sets status = 'ignored_untracked' instead.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function isInternalEmail(senderEmail, senderName, internalPatterns) {
  const emailLower = (senderEmail || '').toLowerCase();
  const nameLower = (senderName || '').toLowerCase();
  return internalPatterns.some(p => emailLower.includes(p) || nameLower.includes(p));
}

function isBuyerDomain(senderEmail, buyerDomains) {
  const domain = (senderEmail || '').toLowerCase().split('@')[1] || '';
  return buyerDomains.has(domain);
}

function matchesTrackedKeyword(subject, bodySnippet, senderEmail, senderName, trackedKeywords) {
  const haystack = `${subject || ''} ${bodySnippet || ''} ${senderEmail || ''} ${senderName || ''}`.toLowerCase();
  return trackedKeywords.some(kw => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    return re.test(haystack);
  });
}

async function loadCurrentConfig() {
  const [buyerRes, internalRes, keywordRes] = await Promise.all([
    supabase.from('tracked_buyer_domains').select('domain').eq('active', true),
    supabase.from('internal_identifiers').select('pattern').eq('active', true),
    supabase.from('tracked_keywords').select('keyword').eq('active', true),
  ]);

  const buyerDomains = new Set((buyerRes.data || []).map(r => r.domain.toLowerCase()));
  const internalPatterns = (internalRes.data || []).map(r => r.pattern.toLowerCase());
  const trackedKeywords = (keywordRes.data || []).map(r => r.keyword.toLowerCase());

  console.log(`[Config] Loaded ${buyerDomains.size} buyer domains, ${internalPatterns.length} internal patterns, ${trackedKeywords.length} keywords`);

  if (buyerDomains.size === 0 || internalPatterns.length === 0) {
    console.error('[Config] ABORTING — buyer domains or internal patterns are empty. Fix Supabase config before running this, or you will delete everything.');
    process.exit(1);
  }

  return { buyerDomains, internalPatterns, trackedKeywords };
}

async function cleanup() {
  const { buyerDomains, internalPatterns, trackedKeywords } = await loadCurrentConfig();

  const { data: rows, error } = await supabase
    .from('emails')
    .select('id, sender_email, sender_name, subject, body_preview, status');

  if (error) {
    console.error('[Cleanup] Query error:', error.message);
    return;
  }

  if (!rows?.length) {
    console.log('[Cleanup] No rows found.');
    return;
  }

  console.log(`[Cleanup] Scanning ${rows.length} total rows against current gate logic...\n`);

  const toDelete = [];
  const toReclassifyInternal = [];
  let keptAsIs = 0;

  for (const row of rows) {
    const isInternal = isInternalEmail(row.sender_email, row.sender_name, internalPatterns);
    const isBuyer = !isInternal && (
      isBuyerDomain(row.sender_email, buyerDomains) ||
      matchesTrackedKeyword(row.subject, row.body_preview, row.sender_email, row.sender_name, trackedKeywords)
    );

    if (isInternal && row.status !== 'internal') {
      toReclassifyInternal.push(row.id);
      console.log(`  [→ internal] ${row.subject?.slice(0, 50)} (${row.sender_email})`);
    } else if (!isInternal && !isBuyer) {
      toDelete.push(row.id);
      console.log(`  [DELETE - untracked] ${row.subject?.slice(0, 50)} (${row.sender_email})`);
    } else {
      keptAsIs++;
    }
  }

  console.log(`\n[Cleanup] Summary: ${toDelete.length} to delete, ${toReclassifyInternal.length} to reclassify as internal, ${keptAsIs} already correct\n`);

  if (toReclassifyInternal.length) {
    const { error: reErr } = await supabase
      .from('emails')
      .update({ status: 'internal', ai_reason: 'Internal identifier match (retroactive cleanup)', updated_at: new Date().toISOString() })
      .in('id', toReclassifyInternal);
    if (reErr) console.error('[Cleanup] Reclassify error:', reErr.message);
    else console.log(`[Cleanup] ✅ Reclassified ${toReclassifyInternal.length} rows as internal`);
  }

  if (toDelete.length) {
    const { error: delErr } = await supabase
      .from('emails')
      .delete()
      .in('id', toDelete);
    if (delErr) console.error('[Cleanup] Delete error:', delErr.message);
    else console.log(`[Cleanup] ✅ Deleted ${toDelete.length} untracked rows`);
  }

  console.log('\n[Cleanup] Done.');
}

cleanup().catch(console.error);

