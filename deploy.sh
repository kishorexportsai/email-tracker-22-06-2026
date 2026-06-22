#!/bin/bash
# ============================================
# KISHOR EMAIL TRACKER — VPS DEPLOY SCRIPT
# Run this on your LOCAL PC, not the server
# Usage: bash deploy.sh
# ============================================

VPS_IP="65.20.91.6"
VPS_USER="root"
APP_DIR="/root/kishor-email-tracker"

echo "🚀 Deploying Kishor Email Tracker to VPS..."

# Upload all files to VPS
echo "📤 Uploading files..."
scp -r ./backend ./frontend ./scripts ./package.json $VPS_USER@$VPS_IP:$APP_DIR/

# Upload .env separately (sensitive)
scp .env $VPS_USER@$VPS_IP:$APP_DIR/.env

echo "⚙️ Setting up server..."
ssh $VPS_USER@$VPS_IP << 'EOF'
  # Install Node.js
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs

  # Install PM2
  npm install -g pm2

  # Go to app directory
  cd /root/kishor-email-tracker

  # Install dependencies
  npm install

  # Stop existing instance if running
  pm2 stop kishor-email-tracker 2>/dev/null || true
  pm2 delete kishor-email-tracker 2>/dev/null || true

  # Start with PM2
  pm2 start backend/server.js --name kishor-email-tracker

  # Save PM2 config (auto-restart on reboot)
  pm2 save
  pm2 startup

  echo "✅ Server started!"
  pm2 status
EOF

echo ""
echo "✅ DEPLOYMENT COMPLETE!"
echo "🌐 Dashboard: http://$VPS_IP:3000"
echo ""
echo "Default login:"
echo "  Email:    admin@kishorexports.com"
echo "  Password: admin123"
echo ""
echo "⚠️  CHANGE THE PASSWORD after first login!"
