import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import matter from 'gray-matter'
import { listMemoryDirs, PROJECTS_ROOT } from './scan.js'
import { addInboxItems, allSignatures } from './inbox.js'
import { containment, grams, jaccard, normalize } from './textsim.js'
import type { InboxEvidence, MemType } from '../shared/types.js'

/**
 * 飞书扫描器（MVP）——"未知的已知"象限的采集管线。
 * 拉取自己最近发出的消息（碎碎念/与同事讨论中的思考），
 * 用你自己配置的 OpenAI 兼容网关上的弱模型初筛起草记忆候选（选私有部署即可让内容不出网），
 * 确定性去重后进收件箱。模型只起草，永不直接写记忆。
 *
 * 用法：npx tsx src/server/feishu-scan.ts [--hours 24] [--max-chats 40] [--dry]
 * 前置：lark-cli 已登录；scripts/scan-job.env 里配好网关（模板见 scan-job.env.example）。
 */

/** 读 scripts/scan-job.env（gitignored 的本机私有配置），手动运行时也能拿到网关配置；已有的环境变量优先 */
function loadLocalEnv() {
  let text = ''
  try {
    text = fs.readFileSync(path.resolve('scripts/scan-job.env'), 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m || process.env[m[1]] !== undefined) continue
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadLocalEnv()

const GATEWAY = process.env.LENS_LLM_URL ?? '' // OpenAI 兼容 /chat/completions 端点
const MODEL = process.env.LENS_LLM_MODEL ?? ''
const API_KEY = process.env.LENS_LLM_KEY ?? ''
// 网关需要附加动态凭证时（如短时 JWT）：header 名 + 打印其值的命令
const EXTRA_HEADER = process.env.LENS_LLM_EXTRA_HEADER ?? ''
const EXTRA_HEADER_CMD = process.env.LENS_LLM_EXTRA_HEADER_CMD ?? ''
const TARGET_BUCKET = process.env.LENS_SCAN_BUCKET ?? '' // 候选写入的记忆桶
const PERSONA = process.env.LENS_SCAN_PERSONA || '用户'
const MAX_CANDIDATES = 5
const MEMORY_COVERED = 0.55
const TOMBSTONE_JACCARD = 0.7

function lark(args: string[]): any {
  const raw = execFileSync('lark-cli', [...args, '--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  })
  const o = JSON.parse(raw)
  if (o.ok === false) throw new Error(`lark-cli 失败: ${JSON.stringify(o.error).slice(0, 300)}`)
  return o.data ?? o
}

interface SelfMessage {
  chat: string
  ts: number
  text: string
}

function pullSelfMessages(hours: number, maxChats: number): SelfMessage[] {
  const me = lark(['contact', '+search-user', '--user-ids', 'me', '--as', 'user'])
  const myOpenId: string = me.users?.[0]?.open_id
  if (!myOpenId) throw new Error('拿不到自己的 open_id')

  const chatData = lark([
    'im', '+chat-list', '--types', 'group,p2p', '--sort', 'active_time', '--page-size', '100', '--as', 'user',
  ])
  const chats: { chat_id: string; name?: string }[] = (chatData.chats ?? chatData.items ?? []).slice(0, maxChats)

  const startISO = new Date(Date.now() - hours * 3600_000).toISOString()
  const out: SelfMessage[] = []
  for (const chat of chats) {
    let msgs: any[] = []
    try {
      const d = lark([
        'im', '+chat-messages-list', '--chat-id', chat.chat_id, '--start', startISO, '--as', 'user', '--no-reactions',
      ])
      msgs = d.messages ?? d.items ?? []
    } catch {
      continue // 无权限/已退群等，跳过
    }
    for (const m of msgs) {
      if (m?.sender?.sender_type !== 'user' || m?.sender?.id !== myOpenId) continue
      if (m?.msg_type !== 'text') continue
      // content 可能是裸文本，也可能是 {"text":...} 的 JSON 字符串
      const c = m?.content
      let text = ''
      if (typeof c === 'string') {
        try {
          text = JSON.parse(c)?.text ?? c
        } catch {
          text = c
        }
      } else {
        text = c?.text ?? ''
      }
      text = text.replace(/@_user_\d+/g, '').trim()
      if (text.length < 8) continue // 太短的寒暄不进料
      out.push({
        chat: chat.name || chat.chat_id,
        ts: Date.parse(m?.create_time ?? '') || 0,
        text,
      })
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

const SYSTEM_PROMPT = `你是记忆初筛员。输入是${PERSONA}最近在飞书里自己发出的消息，按会话分组。
任务：找出值得写进其个人工作记忆库的内容，起草候选。只关注四类：
1. 新技术/新工具/新方法的认知或结论
2. 人际/组织关系的变化（转岗、新对接人、职责调整）
3. 其本人的思考、判断、决策（碎碎念里的真知）
4. 反复出现的工作约定
铁律：
- 宁缺勿滥。日常任务沟通、寒暄、转发、无信息量的消息一律不要。没有值得记的就返回空数组。
- 只依据输入原文，禁止推测和虚构。evidence 必须原文引用。
- 最多 ${MAX_CANDIDATES} 条。
只输出 JSON（不要 markdown 代码块）：
{"candidates":[{"title":"<40字内中文标题>","draft":"<记忆正文草稿，短句列表，含 **Why:** 一行>","type":"feedback|project|reference|user","evidence":[{"chat":"<会话名>","quote":"<原文>"}]}]}`

async function draftCandidates(messages: SelfMessage[]): Promise<any[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`
  if (EXTRA_HEADER && EXTRA_HEADER_CMD) {
    const [cmd, ...args] = EXTRA_HEADER_CMD.split(/\s+/)
    const v = execFileSync(cmd, args, { encoding: 'utf8' }).trim()
    if (!v) throw new Error(`附加凭证命令无输出（可能需要重新登录）: ${EXTRA_HEADER_CMD}`)
    headers[EXTRA_HEADER] = v
  }

  const byChat = new Map<string, SelfMessage[]>()
  for (const m of messages) {
    const list = byChat.get(m.chat) ?? []
    list.push(m)
    byChat.set(m.chat, list)
  }
  let corpus = ''
  for (const [chat, msgs] of byChat) {
    corpus += `\n## 会话：${chat}\n`
    for (const m of msgs) corpus += `- ${new Date(m.ts).toISOString().slice(5, 16)} ${m.text}\n`
  }
  corpus = corpus.slice(0, 60_000)

  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      temperature: 1.0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: corpus },
      ],
    }),
  })
  const data: any = await res.json()
  if (!data.choices) throw new Error(`网关返回异常: ${JSON.stringify(data).slice(0, 300)}`)
  let content: string = data.choices[0].message.content.trim()
  content = content.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
  const parsed = JSON.parse(content)
  if (!Array.isArray(parsed.candidates)) throw new Error(`模型输出缺 candidates 数组: ${content.slice(0, 200)}`)
  return parsed.candidates.slice(0, MAX_CANDIDATES)
}

function memoryGramSets(root: string): Set<string>[] {
  const out: Set<string>[] = []
  for (const memDir of listMemoryDirs(root)) {
    for (const f of fs.readdirSync(memDir).filter((x) => x.endsWith('.md'))) {
      try {
        const fm = matter(fs.readFileSync(path.join(memDir, f), 'utf8'))
        out.push(grams(normalize(String((fm.data as any).description ?? '') + fm.content)))
      } catch {
        continue
      }
    }
  }
  return out
}

async function main() {
  const arg = (name: string, dft: number) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? Number(process.argv[i + 1]) : dft
  }
  const hours = arg('--hours', 24)
  const maxChats = arg('--max-chats', 40)
  const dry = process.argv.includes('--dry')

  if (!GATEWAY || !MODEL)
    throw new Error('未配置 LLM 网关：在 scripts/scan-job.env 设置 LENS_LLM_URL / LENS_LLM_MODEL（参考 scan-job.env.example）')
  if (!TARGET_BUCKET)
    throw new Error('未配置 LENS_SCAN_BUCKET（候选写入哪个记忆桶，即 ~/.claude/projects/ 下的目录名）')

  console.error(`[feishu-scan] 拉取近 ${hours}h 自己发出的消息…`)
  const messages = pullSelfMessages(hours, maxChats)
  console.error(`[feishu-scan] ${messages.length} 条自发消息`)
  if (messages.length === 0) {
    console.log(JSON.stringify({ messages: 0, candidates: 0, written: 0 }))
    return
  }

  const candidates = await draftCandidates(messages)
  console.error(`[feishu-scan] 模型起草 ${candidates.length} 条候选`)

  // 确定性去重：对现有记忆的包含度 + 对收件箱签名（含墓碑）的相似度
  const memSets = memoryGramSets(PROJECTS_ROOT)
  const tombstones = allSignatures(PROJECTS_ROOT).map((s) => grams(s))
  const fresh = candidates.filter((c) => {
    const sig = grams(normalize(`${c.title}${String(c.draft).slice(0, 120)}`))
    if (memSets.some((m) => containment(sig, m) >= MEMORY_COVERED)) return false
    if (tombstones.some((t) => jaccard(sig, t) >= TOMBSTONE_JACCARD)) return false
    return true
  })

  if (!dry && fresh.length > 0) {
    addInboxItems(
      PROJECTS_ROOT,
      TARGET_BUCKET,
      fresh.map((c) => ({
        kind: 'feishu' as const,
        title: String(c.title).slice(0, 60),
        hint: c.evidence?.[0]?.chat ? `来自你的飞书消息（${String(c.evidence[0].chat).slice(0, 20)}）` : '来自你的飞书消息',
        draft: String(c.draft),
        evidence: (c.evidence ?? []).slice(0, 5).map(
          (e: any): InboxEvidence => ({ source: String(e.chat ?? ''), ts: Date.now(), text: String(e.quote ?? '') }),
        ),
        suggestedType: (['feedback', 'project', 'reference', 'user'].includes(c.type) ? c.type : 'reference') as MemType,
        signature: normalize(`${c.title}${String(c.draft).slice(0, 120)}`),
      })),
    )
  }
  console.log(JSON.stringify({ messages: messages.length, candidates: candidates.length, written: dry ? 0 : fresh.length, titles: fresh.map((c) => c.title) }, null, 2))
}

main().catch((e) => {
  console.error(`[feishu-scan] 失败: ${e.message || e}`)
  process.exit(1)
})
