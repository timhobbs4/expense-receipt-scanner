#!/bin/bash
# Gracefully stop the receipt tracker before a new deployment
LOG=/var/log/restartserver.out

echo "=== restartserver.sh (ApplicationStop) at $(date) ===" >> $LOG

# Stop pm2 process if running
pm2 describe receipt-tracker > /dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "Stopping receipt-tracker pm2 process..." >> $LOG
  pm2 stop receipt-tracker >> $LOG 2>&1
else
  echo "receipt-tracker not running, nothing to stop." >> $LOG
fi

echo "=== restartserver.sh done ===" >> $LOG
