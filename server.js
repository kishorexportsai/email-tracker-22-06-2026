require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { runGmailFetcher, runReplyCheckOnly } = require('./gmailFetcher');
const { send36HourNotification, sendDailyReminder, sendWeeklyReport } = require('./reminderSender');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// === ROUTES ===

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.post('/api/trigger/fetch', async (req, res) => {
  console.log('[API] Manual fetch triggered');
  await runGmailFetcher();
  res.json({ status: 'Fetch started' });
});

app.post('/api/trigger/check-replies', async (req, res) => {
  console.log('[API] Manual reply check triggered');
  await runReplyCheckOnly();
  res.json({ status: 'Reply check started' });
});

app.post('/api/trigger/36hour', async (req, res) => {
  console.log('[API] Manual 36-hour check triggered');
  await send36HourNotification();
  res.json({ status: '36-hour check started' });
});

// === CRON JOBS ===

// Every 5 minutes: Fetch emails
cron.schedule('*/5 * * * *', async () => {
  console.log('[Cron] 5-min fetch running...');
  await runGmailFetcher();
});

// Every 10 minutes: Check replies
cron.schedule('*/10 * * * *', async () => {
  console.log('[Cron] 10-min reply check running...');
  await runReplyCheckOnly();
});

// Every 2 hours: 36-hour notification
cron.schedule('0 */2 * * *', async () => {
  console.log('[Cron] 2-hour 36-hour check running...');
  await send36HourNotification();
});

// Daily at 9:30 AM: Daily reminder
cron.schedule('30 3 * * *', async () => {
  console.log('[Cron] Daily reminder running...');
  await sendDailyReminder();
});

// Saturday at 10:30 AM: Weekly report
cron.schedule('30 4 * * 6', async () => {
  console.log('[Cron] Weekly report running...');
  await sendWeeklyReport();
});

// === SERVER ===

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
  console.log(`[Cron] Jobs scheduled and running`);
});
