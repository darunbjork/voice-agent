#!/usr/bin/env bash
set -euo pipefail

echo "→ type-check"
pnpm turbo type-check

echo "→ format check"
pnpm format:check

echo "→ test"
pnpm turbo test --force

echo "→ build"
pnpm turbo build

echo "OK — Day 30 smoke passed"
