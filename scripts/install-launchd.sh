#!/bin/bash
# 渲染 plist 模板并安装两个 LaunchAgent：常驻服务（:5611）+ 每日采集（21:30）
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
NODE_BIN="$(dirname "$(command -v node)")"
LOG_DIR="$HOME/Library/Logs/claude-lens"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

for name in com.claude-lens.server com.claude-lens.daily-scan; do
  sed -e "s|__REPO__|$REPO|g" -e "s|__NODE_BIN__|$NODE_BIN|g" -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "scripts/$name.plist.template" > "$HOME/Library/LaunchAgents/$name.plist"
  launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$name.plist"
done

echo "已安装：com.claude-lens.server 常驻 http://localhost:5611；com.claude-lens.daily-scan 每天 21:30。"
echo "日志：$LOG_DIR/；重启服务：launchctl kickstart -k gui/$(id -u)/com.claude-lens.server"
