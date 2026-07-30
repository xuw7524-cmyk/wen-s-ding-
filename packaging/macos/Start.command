#!/bin/bash
set -u

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) NODE_BIN="$BASE_DIR/runtime/darwin-arm64/node" ;;
  x86_64) NODE_BIN="$BASE_DIR/runtime/darwin-x64/node" ;;
  *)
    osascript -e "display dialog \"这台 Mac 的处理器类型暂不支持：$ARCH\" buttons {\"好\"} default button 1 with icon stop"
    exit 1
    ;;
esac

DATA_DIR="$HOME/Library/Application Support/WensDing"
PID_FILE="$DATA_DIR/backend.pid"
LOG_FILE="$DATA_DIR/backend.log"
mkdir -p "$DATA_DIR"

if ! curl --silent --fail --max-time 1 http://127.0.0.1:4173/health >/dev/null 2>&1; then
  export DINGTALK_REMINDER_PRODUCTION=1
  cd "$BASE_DIR" || exit 1
  nohup "$NODE_BIN" "$BASE_DIR/app/server.js" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
fi

READY=0
for _ in $(seq 1 60); do
  if curl --silent --fail --max-time 1 http://127.0.0.1:4173/health >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.2
done

if [ "$READY" -ne 1 ]; then
  osascript -e "display dialog \"Wen's Ding 后台未能启动。请查看使用说明，或把 backend.log 发给维护者。\" buttons {\"好\"} default button 1 with icon stop"
  exit 1
fi

if [ "${1:-}" != "--background" ]; then
  open http://127.0.0.1:4173/
fi
