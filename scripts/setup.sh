#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if command -v node >/dev/null 2>&1; then
  node scripts/setup.mjs
else
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workspace" -w /workspace node:24-bookworm-slim node scripts/setup.mjs
fi
