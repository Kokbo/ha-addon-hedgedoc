#!/usr/bin/env sh
set -eu

export NODE_ENV=production
export PORT="${PORT:-8099}"
export OPTIONS_PATH="${OPTIONS_PATH:-/data/options.json}"
export DATA_DIR="${DATA_DIR:-/data}"

exec node /app/backend/index.js
