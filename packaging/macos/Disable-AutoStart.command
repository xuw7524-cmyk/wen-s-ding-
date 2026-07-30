#!/bin/bash
set -u

PLIST="$HOME/Library/LaunchAgents/com.wensding.reminder.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
osascript -e 'display dialog "已取消登录后自动运行。" buttons {"好"} default button 1'
