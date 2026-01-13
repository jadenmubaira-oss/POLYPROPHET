#!/bin/bash
# POLYPROPHET Backup Script (Linux/Mac)
# Usage: ./backup.sh
# Requires: REDIS_URL environment variable set

if [ -z "$REDIS_URL" ]; then
    echo "ERROR: REDIS_URL environment variable not set"
    echo "Set it with: export REDIS_URL=your_redis_url_here"
    exit 1
fi

echo "Setting SOURCE_REDIS_URL..."
export SOURCE_REDIS_URL="$REDIS_URL"

echo "Running backup..."
node scripts/migrate-redis.js backup

if [ $? -eq 0 ]; then
    echo ""
    echo "Backup complete! File saved to: redis-export.json"
    echo "Save this file to USB/external drive for nuclear option recovery."
else
    echo "Backup failed!"
    exit 1
fi
