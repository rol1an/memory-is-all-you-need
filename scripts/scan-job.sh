#!/bin/bash
# Claude Lens 每日采集任务：约束挖掘 + 飞书扫描 + 发审核卡片
# 由 LaunchAgent com.claude-lens.daily-scan 定时触发（安装见 scripts/install-launchd.sh）
cd "$(dirname "$0")/.." || exit 1
# 本机私有配置（gitignored）：PATH、LLM 网关、目标桶等，模板见 scan-job.env.example
[ -f scripts/scan-job.env ] && . scripts/scan-job.env

echo "==== scan-job $(date '+%F %T') ===="
npx tsx src/server/miner.ts || echo "[job] miner 失败 exit=$?"
npx tsx src/server/feishu-scan.ts --hours 26 || echo "[job] feishu-scan 失败 exit=$?（网关凭证过期？检查 scripts/scan-job.env）"
npx tsx src/server/notify-card.ts || echo "[job] notify-card 失败 exit=$?"
echo "==== done $(date '+%F %T') ===="
