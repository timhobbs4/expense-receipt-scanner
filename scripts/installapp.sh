#!/bin/bash
# Install Node.js app dependencies
set -e
APP_DIR=/var/www/app
LOG=/var/log/installapp.out

echo "=== installapp.sh starting at $(date) ===" >> $LOG
cd "$APP_DIR"

# Ensure data directory exists and is writable
mkdir -p "$APP_DIR/data"
chmod 755 "$APP_DIR/data"

echo "Running npm install..." >> $LOG
npm install --omit=dev >> $LOG 2>&1

echo "=== installapp.sh done ===" >> $LOG
