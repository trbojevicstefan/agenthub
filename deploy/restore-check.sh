#!/bin/sh
# Monthly restore check. It restores a backup into a temporary Postgres container and counts the users.
# Download the latest backup first, on a computer with read access to the bucket:
#   gcloud storage ls gs://BUCKET/postgres/ | tail -1 | xargs -I{} gcloud storage cp {} latest.dump
#   deploy/restore-check.sh latest.dump
set -eu
dump=${1:?Give the path of a .dump file}
[ -s "$dump" ] || { echo "The file $dump is empty or missing."; exit 1; }
name=opaya-restore-check-$$
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=check -e POSTGRES_DB=opaya postgres:18-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
i=0
until docker exec "$name" pg_isready -U postgres -d opaya >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 60 ] || { echo "Postgres did not start."; exit 1; }; sleep 1
done
docker exec -i "$name" pg_restore -U postgres -d opaya --no-owner --exit-on-error < "$dump"
users=$(docker exec "$name" psql -U postgres -d opaya -tAc 'select count(*) from "user"')
subscriptions=$(docker exec "$name" psql -U postgres -d opaya -tAc 'select count(*) from "subscription"')
echo "Restore check passed: $users users, $subscriptions subscriptions."
