import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import readline from 'node:readline'
import { PROJECTS_ROOT } from './scan.js'
import { listInbox, setInboxStatus } from './inbox.js'
import { buildReviewCard } from './card.js'

/**
 * 卡片回调监听器：消费 card.action.trigger 事件，点击"记住/不记"不再跳浏览器——
 * 直接改收件箱状态并用 token 原地更新卡片（clicked 项消失、计数刷新、清空变绿卡）。
 * 挂在常驻服务进程里，消费者掉线自动重拉（5s 退避）。
 */

const seenEvents = new Set<string>()

function updateCard(token: string, card: any, operatorId: string, log: (m: string) => void) {
  const body = JSON.stringify({ token, card: { ...card, open_ids: [operatorId] } })
  execFile(
    'lark-cli',
    ['api', 'POST', '/open-apis/interactive/v1/card/update', '--as', 'bot', '--data', body, '--format', 'json'],
    { timeout: 15_000 },
    (err, stdout) => {
      if (err) {
        log(`[card-listener] 卡片更新失败: ${String(err).slice(0, 200)}`)
        return
      }
      try {
        const o = JSON.parse(stdout)
        if (o.ok === false) log(`[card-listener] 卡片更新被拒: ${JSON.stringify(o.error).slice(0, 200)}`)
      } catch {
        /* 输出异常只记日志 */
      }
    },
  )
}

export function startCardListener(onInboxChange: () => void, log: (m: string) => void = console.log): void {
  const spawnConsumer = () => {
    // stdin 必须保持打开：无界 consume 在 stdin EOF 时会正常退出（code 0）
    const child = spawn('lark-cli', ['event', 'consume', 'card.action.trigger', '--as', 'bot', '--quiet'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    log('[card-listener] 事件消费者已启动')

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      const eventId = ev.event_id
      if (eventId && seenEvents.has(eventId)) return
      if (eventId) {
        seenEvents.add(eventId)
        if (seenEvents.size > 500) seenEvents.clear()
      }

      let value: any = ev.action_value
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch {
          return
        }
      }
      if (value?.lens !== 'inbox' || !value.bucket || !value.id) return
      const action = value.action === 'accept' ? 'accepted' : 'dismissed'
      try {
        setInboxStatus(PROJECTS_ROOT, value.bucket, value.id, action)
        log(`[card-listener] ${value.id} → ${action}`)
      } catch (e: any) {
        log(`[card-listener] 状态更新失败(可能已处理过): ${e.message}`)
      }
      onInboxChange()

      // 原地重渲卡片：剩余待审 → 新卡片；token 每个事件独立，一次点击一次更新
      if (ev.token) {
        const remaining = listInbox(PROJECTS_ROOT).filter((i) => i.status === 'pending')
        updateCard(ev.token, buildReviewCard(remaining), ev.operator_id ?? '', log)
      }
    })

    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim()
      if (s) log(`[card-listener] ${s.slice(0, 300)}`)
    })
    child.on('error', (e) => {
      // spawn 失败（如 lark-cli 不在 PATH）不能炸掉整个服务
      log(`[card-listener] 消费者启动失败: ${e.message}，30s 后重试`)
      setTimeout(spawnConsumer, 30_000)
    })
    child.on('exit', (code) => {
      log(`[card-listener] 消费者退出(code=${code})，5s 后重启`)
      setTimeout(spawnConsumer, 5000)
    })
  }
  spawnConsumer()
}
