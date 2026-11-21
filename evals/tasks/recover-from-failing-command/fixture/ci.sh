#!/usr/bin/env bash
# What CI runs on every push, from a fresh clone of the repository.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> generate"
node scripts/generate-units.mjs

echo "==> test"
node --test "test/*.test.js"

echo "==> build"
node scripts/build.mjs

echo "==> ok"
