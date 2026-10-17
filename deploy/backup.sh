#!/bin/sh
# Nightly database backup to Google Cloud Storage. Run as root from cron, for example:
#   15 3 * * * /opt/opaya/deploy/backup.sh >> /var/log/opaya-backup.log 2>&1
set -eu
cd "$(dirname "$0")"
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
docker compose exec -T postgres pg_dump -U opaya -d opaya --format=custom --no-owner \
  | docker compose run --rm -T --no-deps web node dist/backup.js "postgres/opaya-$stamp.dump"
