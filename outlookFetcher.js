// backend/outlookFetcher.js
// Fetches emails from all Outlook/Microsoft 365 accounts via Microsoft Graph API

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Get access token from Microsoft
async function getAccessToken() {
  const url = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const response = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return response.data.access_token;
}

// Detect if email is system-generated
function isSystemGenerated(sender, subject) {
  const systemKeywords = ['noreply', 'no-reply', 'donotreply', 'mailer-daemon',
    'postmaster', 'notification', 'alert', 'automated', 'system'];
  const senderLower = (sender || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();
  return systemKeywords.some(k => senderLower.includes(k) || subjectLower.includes(k));
}

// Fetch emails for one Outlook account
async function fetchOutlookEmails(accountEmail, token) {
  try {
    const url = `https://graph.microsoft.com/v1.0/users/${accountEmail}/messages`;
    const params = {
      $top: 50,
      $orderby: 'receivedDateTime desc',
      $select: 'id,conversationId,subject,from,receivedDateTime,bodyPreview,webLink,isDraft'
    };

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });

    const messages = response.data.value || [];
    let saved = 0;

    for (const msg of messages) {
      if (msg.isDraft) continue;

      const senderEmail = msg.from?.emailAddress?.address || '';
      const senderName = msg.from?.emailAddress?.name || '';
      const subject = msg.subject || '(No Subject)';
      const systemGenerated = isSystemGenerated(senderEmail, subject);

      const emailData = {
        email_id: msg.id,
        thread_id: msg.conversationId,
        account: accountEmail,
        source: 'outlook',
        sender_name: senderName,
        sender_email: senderEmail,
        subject: subject,
        body_preview: msg.bodyPreview || '',
        email_link: msg.webLink || '',
        received_at: msg.receivedDateTime,
        status: systemGenerated ? 'system_generated' : 'unreplied',
        is_system_generated: systemGenerated
      };

      const { error } = await supabase
        .from('emails')
        .upsert(emailData, { onConflict: 'email_id', ignoreDuplicates: true });

      if (!error) saved++;
    }

    console.log(`[Outlook] ${accountEmail}: ${saved} emails saved`);
    return saved;
  } catch (err) {
    console.error(`[Outlook] Error fetching ${accountEmail}:`, err.response?.data || err.message);
    return 0;
  }
}

// Check if any unreplied email now has a reply (check sent items)
async function checkOutlookReplies(accountEmail, token) {
  try {
    // Get sent items from last 7 days
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const url = `https://graph.microsoft.com/v1.0/users/${accountEmail}/mailFolders/sentItems/messages`;
    const params = {
      $top: 100,
      $filter: `sentDateTime ge ${since}`,
      $select: 'conversationId,sentDateTime'
    };

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });

    const sentMessages = response.data.value || [];
    const repliedThreadIds = sentMessages.map(m => m.conversationId).filter(Boolean);

    if (repliedThreadIds.length === 0) return;

    // Update emails in those threads to 'replied'
    const { data: unrepliedEmails } = await supabase
      .from('emails')
      .select('id, thread_id')
      .eq('account', accountEmail)
      .eq('status', 'unreplied')
      .in('thread_id', repliedThreadIds);

    if (unrepliedEmails && unrepliedEmails.length > 0) {
      const ids = unrepliedEmails.map(e => e.id);
      await supabase
        .from('emails')
        .update({ status: 'replied', replied_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .in('id', ids);

      console.log(`[Outlook] ${accountEmail}: ${ids.length} emails marked as replied`);
    }
  } catch (err) {
    console.error(`[Outlook] Reply check error for ${accountEmail}:`, err.response?.data || err.message);
  }
}

// Main function — fetch all Outlook accounts
async function runOutlookFetcher() {
  const accounts = (process.env.OUTLOOK_ACCOUNTS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (accounts.length === 0) {
    console.log('[Outlook] No accounts configured');
    return;
  }

  console.log(`[Outlook] Fetching ${accounts.length} accounts...`);
  const token = await getAccessToken();

  for (const account of accounts) {
    await fetchOutlookEmails(account, token);
    await checkOutlookReplies(account, token);
  }

  console.log('[Outlook] Done.');
}

module.exports = { runOutlookFetcher };
