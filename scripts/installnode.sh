#!/bin/bash
# Install Node.js 20.x and pm2 process manager
set -e
LOG=/var/log/installnode.out

echo "=== installnode.sh starting at $(date) ===" >> $LOG

# Install Node.js 20.x via NodeSource if not already at v20+
NODE_VER=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo "0")
if [ "$NODE_VER" -lt "20" ]; then
  echo "Installing Node.js 20.x..." >> $LOG
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >> $LOG 2>&1
  yum install -y nodejs >> $LOG 2>&1
else
  echo "Node.js $NODE_VER already installed, skipping." >> $LOG
fi

# Install pm2 globally
if ! command -v pm2 &> /dev/null; then
  echo "Installing pm2..." >> $LOG
  npm install -g pm2 >> $LOG 2>&1
else
  echo "pm2 already installed." >> $LOG
fi

echo "=== installnode.sh done ===" >> $LOG
