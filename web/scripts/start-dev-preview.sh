#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-127.0.0.1}"
START_PORT="${PORT:-4173}"
MAX_PORT="${MAX_PORT:-4193}"

find_available_port() {
  local port="$1"
  while [ "$port" -le "$MAX_PORT" ]; do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      printf '%s\n' "$port"
      return 0
    fi
    port=$((port + 1))
  done

  return 1
}

PORT_TO_USE="$(find_available_port "$START_PORT")" || {
  echo "No free port found in range ${START_PORT}-${MAX_PORT}" >&2
  exit 1
}

echo "Starting web dev preview on http://${HOST}:${PORT_TO_USE}"
cd "$ROOT_DIR"
exec npm run dev -- --host "$HOST" --port "$PORT_TO_USE"
