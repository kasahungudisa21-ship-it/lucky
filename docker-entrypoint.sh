#!/bin/sh
# Prepares the mounted database volume, then starts the server. The scheduler
# inside the process does the rest: holds, draws, gateway checks and alerts.
set -e

echo "applying schema to ${DATABASE_URL}"
./node_modules/.bin/prisma db push --skip-generate

# idempotent: upserts every house in prisma/seed.ts and the seats it holds
npm run db:seed

echo "starting the portal on ${HOSTNAME}:${PORT}"
exec ./node_modules/.bin/next start
