#!/bin/sh
# Fly release_command (see fly.toml): runs once per deploy, before the new
# machines start. Fly's Postgres machine sleeps when idle and takes more than
# 5 s to wake, so `prisma migrate deploy` failed with P1001. Wait for the DB
# first (SELECT 1, backoff up to ~60 s, every attempt logged), then migrate
# once. Uses the image's own prisma binary: no pnpm or network needed.
set -eu

cd /app/packages/api

echo "[release] waiting for the database"
node dist/scripts/wait-for-db.js

echo "[release] running prisma migrate deploy"
exec ./node_modules/.bin/prisma migrate deploy
