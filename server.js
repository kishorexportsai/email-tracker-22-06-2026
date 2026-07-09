require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { runGmailFetcher, runReplyCheckOnly } = require('./gmailFetcher');
const { send36HourNotification, sendDailyReminder, sendWeeklyReport } = require('./reminderSender');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// === ROOT ROUTE ===
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK',
    message: 'Email Tracker Backend is running',
    dashboard: 'https://email-tracker-22-06-2026.onrender.com/dashboard'
  });
});

// === HEALTH CHECK ===
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// === API ROUTES ===
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
cron.schedule('*/5 * * * *', async () => {
  console.log('[Cron] 5-min fetch running...');
  await runGmailFetcher();
});

cron.schedule('*/10 * * * *', async () => {
  console.log('[Cron] 10-min reply check running...');
  await runReplyCheckOnly();
});

cron.schedule('0 */2 * * *', async () => {
  console.log('[Cron] 2-hour 36-hour check running...');
  await send36HourNotification();
});

cron.schedule('30 3 * * *', async () => {
  console.log('[Cron] Daily reminder running...');
  await sendDailyReminder();
});

cron.schedule('30 4 * * 6', async () => {
  console.log('[Cron] Weekly report running...');
  await sendWeeklyReport();
});

// === SERVER ===
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Dashboard: https://email-tracker-22-06-2026.onrender.com/dashboard`);
  console.log(`[Cron] Jobs scheduled and running`);
});
