require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SENDER_EMAIL,
    pass: process.env.SENDER_PASSWORD,
  },
});

async function send36HourNotification() {
  try {
    console.log('[Reminder] 36-hour check started');

    const { data: unreplied } = await supabase
      .from('emails')
      .select('id, sender_email, subject, received_at')
      .eq('status', 'unreplied');

    if (!unreplied?.length) {
      console.log('[Reminder] No unreplied emails');
      return;
    }

    const thirtyHours = 36 * 60 * 60 * 1000;
    const now = Date.now();
    const emailsOver36h = unreplied.filter(e => {
      const receivedTime = new Date(e.received_at).getTime();
      return (now - receivedTime) > thirtyHours;
    });

    if (!emailsOver36h.length) {
      console.log('[Reminder] No emails over 36 hours');
      return;
    }

    const emailList = emailsOver36h
      .map(e => `• ${e.sender_email}: ${e.subject}`)
      .join('\n');

    const message = {
      from: process.env.SENDER_EMAIL,
      to: 'adiya@kishorexports.com,deepak@kishorexports.com',
      subject: `🚨 URGENT: ${emailsOver36h.length} emails unreplied for 36+ hours`,
      html: `
        <h2>Unreplied Emails Alert</h2>
        <p>The following emails have NOT been replied for <strong>36+ hours</strong>:</p>
        <pre>${emailList}</pre>
        <p><a href="https://email-tracker-22-06-2026.onrender.com">View Dashboard</a></p>
      `,
    };

    await transporter.sendMail(message);
    console.log('[Reminder] 36-hour notification sent');

  } catch (err) {
    console.error('[Reminder] Error:', err.message);
  }
}

async function sendDailyReminder() {
  try {
    console.log('[Reminder] Daily reminder started');

    const { data: unreplied } = await supabase
      .from('emails')
      .select('id, sender_email, subject, received_at')
      .eq('status', 'unreplied');

    if (!unreplied?.length) {
      console.log('[Reminder] No unreplied emails for daily reminder');
      return;
    }

    const emailList = unreplied
      .map(e => `• ${e.sender_email}: ${e.subject}`)
      .join('\n');

    const message = {
      from: process.env.SENDER_EMAIL,
      to: 'adiya@kishorexports.com,deepak@kishorexports.com',
      subject: `📧 Daily Reminder: ${unreplied.length} emails need reply`,
      html: `
        <h2>Daily Email Reminder</h2>
        <p>You have <strong>${unreplied.length} unreplied emails</strong>:</p>
        <pre>${emailList}</pre>
        <p><a href="https://email-tracker-22-06-2026.onrender.com">View Dashboard</a></p>
      `,
    };

    await transporter.sendMail(message);
    console.log('[Reminder] Daily reminder sent');

  } catch (err) {
    console.error('[Reminder] Error:', err.message);
  }
}

async function sendWeeklyReport() {
  try {
    console.log('[Reminder] Weekly report started');

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: weekly } = await supabase
      .from('emails')
      .select('status')
      .gte('received_at', sevenDaysAgo.toISOString());

    const total = weekly?.length || 0;
    const replied = weekly?.filter(e => e.status === 'replied').length || 0;
    const unreplied = total - replied;

    const message = {
      from: process.env.SENDER_EMAIL,
      to: 'admin@kishorexports.com',
      subject: `📊 Weekly Email Report`,
      html: `
        <h2>Weekly Email Summary</h2>
        <p><strong>Total Emails:</strong> ${total}</p>
        <p><strong>Replied:</strong> ${replied}</p>
        <p><strong>Unreplied:</strong> ${unreplied}</p>
        <p><a href="https://email-tracker-22-06-2026.onrender.com">View Dashboard</a></p>
      `,
    };

    await transporter.sendMail(message);
    console.log('[Reminder] Weekly report sent');

  } catch (err) {
    console.error('[Reminder] Error:', err.message);
  }
}

module.exports = { send36HourNotification, sendDailyReminder, sendWeeklyReport };
