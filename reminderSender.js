// backend/reminderSender.js
// Sends daily and weekly email reminders about unreplied emails

require('dotenv').config();
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SENDER_EMAIL,
    pass: process.env.SENDER_PASSWORD
  }
});

function formatEmailRow(email) {
  return `
    <tr style="border-bottom:1px solid #eee;">
      <td style="padding:10px;color:#333;">${email.sender_name || email.sender_email}</td>
      <td style="padding:10px;color:#333;">${email.subject}</td>
      <td style="padding:10px;color:#666;">${new Date(email.received_at).toLocaleDateString('en-IN')}</td>
      <td style="padding:10px;">
        <a href="${email.email_link}" style="color:#2E86C1;text-decoration:none;">Open Email</a>
      </td>
    </tr>`;
}

function buildEmailHTML(title, subtitle, emails, footerNote = '') {
  return `
  <!DOCTYPE html>
  <html>
  <body style="font-family:Arial,sans-serif;background:#f4f6f9;margin:0;padding:20px;">
    <div style="max-width:700px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
      <div style="background:#1E3A5F;padding:24px;color:white;">
        <h1 style="margin:0;font-size:22px;">Kishor Exports</h1>
        <p style="margin:4px 0 0;opacity:0.8;font-size:14px;">Email Tracker System</p>
      </div>
      <div style="padding:24px;">
        <h2 style="color:#1E3A5F;margin-top:0;">${title}</h2>
        <p style="color:#666;">${subtitle}</p>
        ${emails.length === 0 ? '<p style="color:green;font-weight:bold;">✅ All emails have been replied to!</p>' : `
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <thead>
            <tr style="background:#f0f4f8;">
              <th style="padding:10px;text-align:left;color:#1E3A5F;">From</th>
              <th style="padding:10px;text-align:left;color:#1E3A5F;">Subject</th>
              <th style="padding:10px;text-align:left;color:#1E3A5F;">Received</th>
              <th style="padding:10px;text-align:left;color:#1E3A5F;">Link</th>
            </tr>
          </thead>
          <tbody>
            ${emails.map(formatEmailRow).join('')}
          </tbody>
        </table>`}
        ${footerNote ? `<p style="color:#666;font-size:13px;margin-top:20px;padding-top:16px;border-top:1px solid #eee;">${footerNote}</p>` : ''}
      </div>
      <div style="background:#f8f9fa;padding:16px;text-align:center;color:#999;font-size:12px;">
        Kishor Exports Email Tracker — Internal Use Only
      </div>
    </div>
  </body>
  </html>`;
}

// Send daily reminder to each agent about their unreplied emails
async function sendDailyAgentReminders() {
  console.log('[Reminder] Sending daily agent reminders...');

  const { data: users } = await supabase
    .from('users')
    .select('*')
    .eq('role', 'agent')
    .eq('is_active', true);

  if (!users || users.length === 0) return;

  for (const user of users) {
    const { data: unreplied } = await supabase
      .from('emails')
      .select('*')
      .eq('account', user.account_email)
      .eq('status', 'unreplied')
      .order('received_at', { ascending: false });

    if (!unreplied || unreplied.length === 0) continue;

    const html = buildEmailHTML(
      `⚠️ ${unreplied.length} Email${unreplied.length > 1 ? 's' : ''} Need Your Reply`,
      `Hi ${user.name}, the following emails in your account (${user.account_email}) still need a reply:`,
      unreplied,
      'Please reply to these emails at your earliest convenience.'
    );

    await transporter.sendMail({
      from: `"Kishor Email Tracker" <${process.env.SENDER_EMAIL}>`,
      to: user.email,
      subject: `⚠️ ${unreplied.length} emails need your reply — ${new Date().toLocaleDateString('en-IN')}`,
      html
    });

    // Log it
    await supabase.from('reminder_logs').insert({
      type: 'daily_agent',
      sent_to: user.email,
      email_count: unreplied.length
    });

    console.log(`[Reminder] Daily sent to ${user.email} — ${unreplied.length} unreplied`);
  }
}

// Send daily summary to managers
async function sendDailyManagerReminders() {
  console.log('[Reminder] Sending daily manager reminders...');

  const { data: managers } = await supabase
    .from('users')
    .select('*')
    .eq('role', 'manager')
    .eq('is_active', true);

  if (!managers || managers.length === 0) return;

  for (const manager of managers) {
    // Get all agents under this manager
    const { data: agents } = await supabase
      .from('users')
      .select('*')
      .eq('manager_email', manager.email)
      .eq('role', 'agent');

    if (!agents || agents.length === 0) continue;

    const accountEmails = agents.map(a => a.account_email).filter(Boolean);
    const { data: unreplied } = await supabase
      .from('emails')
      .select('*')
      .in('account', accountEmails)
      .eq('status', 'unreplied')
      .order('account', { ascending: true })
      .order('received_at', { ascending: false });

    if (!unreplied || unreplied.length === 0) continue;

    const html = buildEmailHTML(
      `📋 Team Unreplied Emails — ${new Date().toLocaleDateString('en-IN')}`,
      `Hi ${manager.name}, here are all unreplied emails across your team:`,
      unreplied,
      `Total unreplied: ${unreplied.length} across ${accountEmails.length} accounts.`
    );

    await transporter.sendMail({
      from: `"Kishor Email Tracker" <${process.env.SENDER_EMAIL}>`,
      to: manager.email,
      subject: `📋 Team Unreplied Emails: ${unreplied.length} pending — ${new Date().toLocaleDateString('en-IN')}`,
      html
    });

    await supabase.from('reminder_logs').insert({
      type: 'daily_manager',
      sent_to: manager.email,
      email_count: unreplied.length
    });

    console.log(`[Reminder] Manager daily sent to ${manager.email}`);
  }
}

// Send weekly report every Saturday
async function sendWeeklyReports() {
  console.log('[Reminder] Sending weekly reports...');

  const { data: agents } = await supabase
    .from('users')
    .select('*')
    .eq('role', 'agent')
    .eq('is_active', true);

  if (!agents || agents.length === 0) return;

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);

  for (const agent of agents) {
    // Get all emails this week
    const { data: allEmails } = await supabase
      .from('emails')
      .select('*')
      .eq('account', agent.account_email)
      .gte('received_at', weekStart.toISOString());

    // Get still-unreplied emails
    const { data: unreplied } = await supabase
      .from('emails')
      .select('*')
      .eq('account', agent.account_email)
      .eq('status', 'unreplied')
      .gte('received_at', weekStart.toISOString());

    const totalReceived = allEmails?.length || 0;
    const totalReplied = totalReceived - (unreplied?.length || 0);

    const html = buildEmailHTML(
      `📊 Weekly Email Report — ${agent.name}`,
      `Week: ${weekStart.toLocaleDateString('en-IN')} to ${new Date().toLocaleDateString('en-IN')}<br>
       <strong>Total Received:</strong> ${totalReceived} &nbsp;&nbsp;
       <strong>Replied:</strong> ${totalReplied} &nbsp;&nbsp;
       <strong>Still Unreplied:</strong> ${unreplied?.length || 0}`,
      unreplied || [],
      'This report only shows emails that are STILL unreplied as of today.'
    );

    // Get manager and senior manager emails
    const ccEmails = [
      ...((process.env.MANAGER_EMAILS || '').split(',').filter(Boolean)),
      ...((process.env.SENIOR_MANAGER_EMAILS || '').split(',').filter(Boolean))
    ].join(',');

    await transporter.sendMail({
      from: `"Kishor Email Tracker" <${process.env.SENDER_EMAIL}>`,
      to: agent.email,
      cc: ccEmails || undefined,
      subject: `📊 Weekly Report — ${agent.name} | ${weekStart.toLocaleDateString('en-IN')} – ${new Date().toLocaleDateString('en-IN')}`,
      html
    });

    await supabase.from('reminder_logs').insert({
      type: 'weekly',
      sent_to: agent.email,
      email_count: unreplied?.length || 0
    });

    console.log(`[Reminder] Weekly report sent to ${agent.email}`);
  }
}

module.exports = { sendDailyAgentReminders, sendDailyManagerReminders, sendWeeklyReports };
