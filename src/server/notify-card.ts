import { execFileSync } from 'node:child_process'
import { PROJECTS_ROOT } from './scan.js'
import { listInbox } from './inbox.js'
import { buildReviewCard, hintOf } from './card.js'

/**
 * 收件箱飞书卡片：把待审候选发到专用群「记忆观测台」。
 * bot 身份发送（租户禁用 send_as_user；lark-cli 的 bot 需先入群，可用用户身份 API 拉入）。
 * 按钮是回调型：点击不跳浏览器，常驻服务里的 card-listener 消费事件、改状态、原地更新卡片。
 * 降级路径（卡片被拒时）才使用 URL 链接。
 * 用法：npx tsx src/server/notify-card.ts [--dry]
 */

const LENS = 'http://localhost:5611'
const MAX_CARDS = 5
const GROUP_NAME = '记忆观测台'

function lark(args: string[]): any {
  const raw = execFileSync('lark-cli', [...args, '--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  })
  const o = JSON.parse(raw)
  if (o.ok === false) throw new Error(`lark-cli 失败: ${JSON.stringify(o.error).slice(0, 300)}`)
  return o.data ?? o
}

function actUrl(bucket: string, id: string, action: 'accept' | 'dismiss'): string {
  return `${LENS}/inbox/act?bucket=${encodeURIComponent(bucket)}&id=${encodeURIComponent(id)}&action=${action}`
}

function main() {
  const dry = process.argv.includes('--dry')
  const pending = listInbox(PROJECTS_ROOT).filter((i) => i.status === 'pending')
  if (pending.length === 0) {
    console.log(JSON.stringify({ pending: 0, sent: false }))
    return
  }

  const card = buildReviewCard(pending)
  const shown = pending.slice(0, 5)

  if (dry) {
    console.log(JSON.stringify(card, null, 2))
    return
  }

  // 目的地：专用通知群「记忆观测台」，lark-cli 的 bot 已入群、以 bot 身份发送
  // （租户策略禁用 send_as_user，用户身份发消息一律 230027——2026-07-26 实测）。
  // 群名解析不写死 ID；可用 LENS_NOTIFY_CHAT 覆盖。
  let chatId = process.env.LENS_NOTIFY_CHAT || ''
  if (!chatId) {
    const found = lark(['im', '+chat-search', '--query', GROUP_NAME, '--as', 'user'])
    chatId = (found.chats ?? found.items ?? [])[0]?.chat_id ?? ''
  }
  if (!chatId) {
    throw new Error(
      `找不到通知群「${GROUP_NAME}」。在飞书里建一个只有自己的群、名字叫「${GROUP_NAME}」，或设置环境变量 LENS_NOTIFY_CHAT=<chat_id>`,
    )
  }

  // 注意：query 参数必须走 --params，写进路径会被丢掉（receive_id_type 缺失 → 99992402）
  const send = (msgType: string, content: string) =>
    lark([
      'api', 'POST', '/open-apis/im/v1/messages',
      '--params', JSON.stringify({ receive_id_type: 'chat_id' }),
      '--as', 'bot',
      '--data', JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
    ])

  try {
    const result = send('interactive', JSON.stringify(card))
    console.log(JSON.stringify({ pending: pending.length, sent: 'card', message_id: result?.message_id }))
  } catch (e: any) {
    // 卡片被字段校验拒绝（如 localhost 按钮 URL）→ 降级纯文本，链接仍可点
    console.error(`[notify-card] 卡片被拒，降级纯文本: ${String(e.message).slice(0, 160)}`)
    const lines = [`【${pending.length} 条新记忆等你点头】`]
    shown.forEach((item, idx) => {
      lines.push(
        `${idx + 1}. ${item.title}（${hintOf(item)}）`,
        `   记住 ${actUrl(item.bucket, item.id, 'accept')}`,
        `   不记 ${actUrl(item.bucket, item.id, 'dismiss')}`,
      )
    })
    if (pending.length > shown.length) lines.push(`…还有 ${pending.length - shown.length} 条`)
    lines.push(`观测台收件箱：${LENS}/`)
    const result = send('text', JSON.stringify({ text: lines.join('\n') }))
    console.log(JSON.stringify({ pending: pending.length, sent: 'text-fallback', message_id: result?.message_id }))
  }
}

try {
  main()
} catch (e: any) {
  console.error(`[notify-card] 失败: ${e.message || e}`)
  process.exit(1)
}
