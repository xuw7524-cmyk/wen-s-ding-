#!/bin/bash
set -u

DATA_DIR="$HOME/Library/Application Support/WensDing"
PID_FILE="$DATA_DIR/backend.pid"

launchctl kill SIGTERM "gui/$(id -u)/com.wensding.reminder" >/dev/null 2>&1 || true

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      kill -0 "$PID" >/dev/null 2>&1 || break
      sleep 0.1
    done
  fi
  rm -f "$PID_FILE"
fi

osascript -e "display notification \"后台已停止\" with title \"Wen's Ding\""
