#!/bin/bash
# Start the receipt tracker server with pm2
APP_DIR=/var/www/app
LOG=/var/log/startserver.out

echo "=== startserver.sh starting at $(date) ===" >> $LOG
cd "$APP_DIR"

# Load ANTHROPIC_API_KEY from .env if it exists
if [ -f "$APP_DIR/.env" ]; then
  export $(grep -v '^#' "$APP_DIR/.env" | xargs)
fi

# Start or restart with pm2
pm2 describe receipt-tracker > /dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "Restarting existing pm2 process..." >> $LOG
  pm2 restart receipt-tracker >> $LOG 2>&1
else
  echo "Starting new pm2 process..." >> $LOG
  pm2 start server.js --name receipt-tracker --env production >> $LOG 2>&1
fi

pm2 save >> $LOG 2>&1

# Enable pm2 startup on boot (Amazon Linux 2)
pm2 startup systemd -u ec2-user --hp /home/ec2-user >> $LOG 2>&1 || true

echo "=== startserver.sh done ===" >> $LOG
