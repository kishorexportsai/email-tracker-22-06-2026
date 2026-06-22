# Kishor Exports — Email Tracker & CRM

## Quick Setup Guide

---

## STEP 1 — Supabase Tables

1. Go to your Supabase project → SQL Editor
2. Paste the contents of `scripts/supabase_setup.sql`
3. Click Run

---

## STEP 2 — Fill in .env file

Open `.env` and fill these values:

```
SUPABASE_URL=          ← Your Supabase project URL
SUPABASE_SERVICE_KEY=  ← Your service_role key (not anon key)

OUTLOOK_ACCOUNTS=      ← hi@kishorexports.com,staff2@kishorexports.com,...
GMAIL_ACCOUNTS=        ← gmail1@gmail.com,gmail2@gmail.com,...

SENDER_EMAIL=          ← Gmail account to send reminders FROM
SENDER_PASSWORD=       ← Gmail App Password (not regular password)
                         → Get from: myaccount.google.com → Security → App Passwords

MANAGER_EMAILS=        ← manager@kishorexports.com
SENIOR_MANAGER_EMAILS= ← boss@kishorexports.com
```

---

## STEP 3 — Gmail App Password Setup

1. Go to: myaccount.google.com
2. Security → 2-Step Verification → App passwords
3. Create app password for "Mail"
4. Put that 16-character password in SENDER_PASSWORD

---

## STEP 4 — Add Users to Dashboard

In Supabase SQL Editor, run this for each staff member:

```sql
INSERT INTO users (name, email, password_hash, role, account_email, manager_email)
VALUES (
  'Aryan',
  'aryan@kishorexports.com',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- password: admin123
  'agent',
  'aryan.gmail@gmail.com',    -- the Gmail/Outlook account to monitor
  'manager@kishorexports.com' -- their manager's email
);
```

To generate a proper password hash, run:
```bash
node -e "const b=require('bcryptjs');console.log(b.hashSync('yourpassword',10))"
```

---

## STEP 5 — Deploy to VPS

On your local PC (with SSH access):

```bash
# First time setup on VPS:
ssh root@65.20.91.6

# On the VPS:
mkdir -p /root/kishor-email-tracker
exit

# Upload files from your PC:
bash deploy.sh
```

Or manually:
```bash
# SSH into VPS
ssh root@65.20.91.6

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2
npm install -g pm2

# Create app folder and upload your files
mkdir -p /root/kishor-email-tracker
# (upload files via SCP or FileZilla)

# Install and start
cd /root/kishor-email-tracker
npm install
pm2 start backend/server.js --name kishor-email-tracker
pm2 save
pm2 startup
```

---

## STEP 6 — Access Dashboard

Open browser: `http://65.20.91.6:3000`

Default login:
- Email: `admin@kishorexports.com`
- Password: `admin123`

**Change this password immediately!**

---

## How it works

| Schedule | Action |
|---|---|
| Every 5 minutes | Fetch new emails from all accounts, check reply status |
| Daily 9:00 AM | Send agents their unreplied email list |
| Daily 9:00 AM | Send managers their team's unreplied list |
| Saturday 10:00 AM | Send weekly reports to all + CC managers |

---

## Useful PM2 Commands (on VPS)

```bash
pm2 status                    # Check if running
pm2 logs kishor-email-tracker # View live logs
pm2 restart kishor-email-tracker # Restart
pm2 stop kishor-email-tracker # Stop
```
