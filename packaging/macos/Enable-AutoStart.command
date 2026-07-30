#!/bin/bash
set -u

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) NODE_BIN="$BASE_DIR/runtime/darwin-arm64/node" ;;
  x86_64) NODE_BIN="$BASE_DIR/runtime/darwin-x64/node" ;;
  *) exit 1 ;;
esac

DATA_DIR="$HOME/Library/Application Support/WensDing"
PLIST="$HOME/Library/LaunchAgents/com.wensding.reminder.plist"
mkdir -p "$DATA_DIR" "$HOME/Library/LaunchAgents"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

NODE_XML="$(xml_escape "$NODE_BIN")"
SERVER_XML="$(xml_escape "$BASE_DIR/app/server.js")"
BASE_XML="$(xml_escape "$BASE_DIR")"
LOG_XML="$(xml_escape "$DATA_DIR/backend.log")"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wensding.reminder</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_XML</string><string>$SERVER_XML</string></array>
  <key>WorkingDirectory</key><string>$BASE_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DINGTALK_REMINDER_PRODUCTION</key><string>1</string>
    <key>WENS_DING_SUPERVISED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_XML</string>
  <key>StandardErrorPath</key><string>$LOG_XML</string>
</dict>
</plist>
EOF

if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  osascript -e 'display dialog "已设置为登录后自动运行。" buttons {"好"} default button 1'
else
  osascript -e 'display dialog "设置失败，请把使用说明中的信息发给维护者。" buttons {"好"} default button 1 with icon stop'
  exit 1
fi
