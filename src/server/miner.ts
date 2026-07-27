import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import matter from 'gray-matter'
import { listMemoryDirs, PROJECTS_ROOT } from './scan.js'
import { addInboxItems, allSignatures } from './inbox.js'
import { UnionFind, containment, grams, jaccard, normalize } from './textsim.js'
import { shortBucket } from '../shared/bucket.js'
import type { InboxEvidence } from '../shared/types.js'

/**
 * 重复约束挖掘器（零模型）——"已知的未知"象限的采集管线。
 * 原理：用户在多个会话里反复敲进对话框的同一句约束/偏好，
 * 说明它还没被记忆系统固化。相似句聚类 + 对现有记忆去重后进收件箱。
 */

const MIN_SESSIONS = 3 // 至少出现在几个不同会话
const CLUSTER_JACCARD = 0.6 // 相似句聚类阈值
const MEMORY_COVERED = 0.6 // 与某条记忆的包含度超过此值 = 已被记忆覆盖
const TOMBSTONE_JACCARD = 0.7 // 与已有收件箱条目（含墓碑）的相似阈值
const MAX_EVIDENCE = 5

interface Occurrence {
  bucket: string
  session: string
  ts: number
  text: string
  /** 句子在原消息里的前后文摘录（±60 字），进证据供人理解语境 */
  context: string
  /** 来源消息总长——人敲的约束住在短消息里，模板句子住在巨型消息里 */
  msgLen: number
}

const WRAPPER_PREFIXES = ['<local-command', '<command-name', '<task-notification', 'Caveat:', '[Request interrupted']
const ACK_RE = /^(好的?|嗯+|可以|行吧?|ok(ay)?|好嘞|继续|开始吧?|go|不用了?|谢谢|收到|对的?|是的?|没问题|先这样|哈哈+|👍|yes|no|嗯呢)$/i
/** 粘贴物噪音：图片占位、文件路径、key:value 结构化数据、引号开头的 JSON/代码行 */
const PASTE_NOISE_RE = /^(\[image[:\s]|['"]?[~/]|[\w.-]+:\s*\S+$|["'{}\[\]])/i
/** 疑问句不是约束（"这条回复有帮助吗？"这类粘贴进来的机器人文案曾被误收） */
const QUESTION_RE = /[吗嘛么呢]?[？?]\s*$/
/** 粘贴的飞书聊天记录指纹：≥3 行裸时间戳（如 09:59）即整条消息跳过 */
function looksLikePastedChat(text: string): boolean {
  const bareTimestamps = text.match(/^\s*\d{1,2}:\d{2}\s*$/gm)
  return (bareTimestamps?.length ?? 0) >= 3
}

interface UserMessage {
  bucket: string
  session: string
  ts: number
  text: string
}

function extractUserMessages(file: string, bucket: string, session: string): UserMessage[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: UserMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.includes('"type":"user"')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type !== 'user') continue
    const content = o?.message?.content
    if (typeof content !== 'string') continue // tool_result 等是数组，真人输入是字符串
    if (WRAPPER_PREFIXES.some((p) => content.startsWith(p))) continue
    const ts = Date.parse(o.timestamp ?? '') || 0
    // 去掉夹带的 system-reminder 块
    const clean = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    if (looksLikePastedChat(clean)) continue // 粘贴的聊天记录不是"你输入的约束"
    out.push({ bucket, session, ts, text: clean })
  }
  return out
}

/** 句子拆分 + 逐句过滤；context = 句子在消息里的前后文摘录 */
function* messageSentences(msg: UserMessage): Generator<Occurrence> {
  for (const s of msg.text.split(/(?<=[。！？!?；;\n])/)) {
    const text = s.trim()
    if (!text || text.startsWith('/')) continue // slash 命令不算约束
    if (PASTE_NOISE_RE.test(text)) continue
    if (QUESTION_RE.test(text)) continue
    const idx = msg.text.indexOf(text)
    const context = msg.text
      .slice(Math.max(0, idx - 60), idx + text.length + 60)
      .replace(/\s+/g, ' ')
      .trim()
    yield { bucket: msg.bucket, session: msg.session, ts: msg.ts, text, context, msgLen: msg.text.length }
  }
}

function listSessionFiles(root: string): { file: string; bucket: string; session: string }[] {
  const out: { file: string; bucket: string; session: string }[] = []
  for (const memDir of listMemoryDirs(root)) {
    const bucketDir = path.dirname(memDir)
    const bucket = path.basename(bucketDir)
    let files: string[] = []
    try {
      files = fs.readdirSync(bucketDir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) out.push({ file: path.join(bucketDir, f), bucket, session: f.replace(/\.jsonl$/, '') })
  }
  return out
}

/** 现有记忆语料的 gram 集（description + 正文），覆盖检测用 */
function memoryGramSets(root: string): { name: string; set: Set<string> }[] {
  const out: { name: string; set: Set<string> }[] = []
  for (const memDir of listMemoryDirs(root)) {
    let files: string[] = []
    try {
      files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const fm = matter(fs.readFileSync(path.join(memDir, f), 'utf8'))
        const text = normalize(String((fm.data as any).description ?? '') + fm.content)
        out.push({ name: f, set: grams(text) })
      } catch {
        continue
      }
    }
  }
  return out
}

export interface MinerReport {
  sessionsScanned: number
  sentences: number
  scriptedMessages: number
  clusters: number
  qualified: number
  covered: number
  tombstoned: number
  proposed: { bucket: string; title: string; sessions: number }[]
}

export function mine(root: string = PROJECTS_ROOT, minSessions = MIN_SESSIONS, dry = false): MinerReport {
  // 1a. 收集全部消息，先剔除"管线模板家族"：长消息（norm>60）跨会话高相似
  //     （骨架相同、细节逐日变化，如定时派单模板、每日调研管线的注入 prompt）。
  //     人类不会在多个会话里打出高度相似的长文——那是脚本干的。
  const files = listSessionFiles(root)
  const messages: UserMessage[] = []
  for (const { file, bucket, session } of files) {
    messages.push(...extractUserMessages(file, bucket, session))
  }
  const longIdx: number[] = []
  const longSets: Set<string>[] = []
  messages.forEach((m, i) => {
    const norm = normalize(m.text)
    if (norm.length > 60) {
      longIdx.push(i)
      longSets.push(grams(norm.slice(0, 2000))) // 截前 2000 字符足够识别骨架
    }
  })
  const mUf = new UnionFind(longIdx.length)
  const mInverted = new Map<string, number[]>()
  longSets.forEach((set, i) => {
    for (const g of set) {
      const list = mInverted.get(g)
      if (list) list.push(i)
      else mInverted.set(g, [i])
    }
  })
  longSets.forEach((set, i) => {
    const shared = new Map<number, number>()
    for (const g of set) {
      const list = mInverted.get(g)
      if (!list || list.length > 300) continue
      for (const j of list) {
        if (j <= i) continue
        shared.set(j, (shared.get(j) ?? 0) + 1)
      }
    }
    for (const [j, cnt] of shared) {
      if (cnt < Math.min(set.size, longSets[j].size) * 0.4) continue
      if (jaccard(set, longSets[j]) >= 0.5) mUf.union(i, j)
    }
  })
  const familyMembers = new Map<number, number[]>()
  longIdx.forEach((_, i) => {
    const r = mUf.find(i)
    const list = familyMembers.get(r)
    if (list) list.push(i)
    else familyMembers.set(r, [i])
  })
  const scripted = new Set<number>() // messages 数组的下标
  for (const members of familyMembers.values()) {
    const sessions = new Set(members.map((i) => messages[longIdx[i]].session))
    if (sessions.size >= 2) for (const i of members) scripted.add(longIdx[i])
  }
  // 第二道防线：数字/十六进制剥离后的骨架哈希——只有日期/ID 在变的模板（payload 注入）
  // 逃得过模糊聚类（超高频 gram 被倒排上限跳过），逃不过 O(n) 的骨架精确匹配
  const scaffoldSessions = new Map<string, Set<string>>()
  const scaffoldOf = (m: UserMessage) =>
    normalize(m.text).replace(/[0-9a-f]{6,}/gi, '').replace(/\d+/g, '')
  messages.forEach((m) => {
    const sc = scaffoldOf(m)
    if (sc.length <= 40) return
    const s = scaffoldSessions.get(sc) ?? new Set<string>()
    s.add(m.session)
    scaffoldSessions.set(sc, s)
  })
  messages.forEach((m, i) => {
    if (scripted.has(i)) return
    const sc = scaffoldOf(m)
    if (sc.length > 40 && (scaffoldSessions.get(sc)?.size ?? 0) >= 2) scripted.add(i)
  })

  // 1b. 逐句拆分，按归一化形态聚合
  const byNorm = new Map<string, { occ: Occurrence[]; gset: Set<string> }>()
  let sentenceCount = 0
  let scriptedSkipped = 0
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi]
    if (scripted.has(mi)) {
      scriptedSkipped++
      continue
    }
    for (const occ of messageSentences(m)) {
      const norm = normalize(occ.text)
      if (norm.length < 6 || norm.length > 120) continue
      if (ACK_RE.test(norm)) continue
      sentenceCount++
      let e = byNorm.get(norm)
      if (!e) {
        e = { occ: [], gset: grams(norm) }
        byNorm.set(norm, e)
      }
      e.occ.push(occ)
    }
  }

  // 2. 相似句聚类：倒排索引筛候选对 + Jaccard 并查集
  const norms = [...byNorm.keys()]
  const uf = new UnionFind(norms.length)
  const inverted = new Map<string, number[]>()
  norms.forEach((n, i) => {
    for (const g of byNorm.get(n)!.gset) {
      const list = inverted.get(g)
      if (list) list.push(i)
      else inverted.set(g, [i])
    }
  })
  const seenPairs = new Set<string>()
  norms.forEach((n, i) => {
    const shared = new Map<number, number>()
    for (const g of byNorm.get(n)!.gset) {
      const list = inverted.get(g)
      if (!list || list.length > 200) continue // 超高频 gram 不做证据
      for (const j of list) {
        if (j <= i) continue
        shared.set(j, (shared.get(j) ?? 0) + 1)
      }
    }
    for (const [j, cnt] of shared) {
      if (cnt < 4) continue
      const key = `${i}-${j}`
      if (seenPairs.has(key)) continue
      seenPairs.add(key)
      if (jaccard(byNorm.get(norms[i])!.gset, byNorm.get(norms[j])!.gset) >= CLUSTER_JACCARD) uf.union(i, j)
    }
  })
  const clusters = new Map<number, number[]>()
  norms.forEach((_, i) => {
    const r = uf.find(i)
    const list = clusters.get(r)
    if (list) list.push(i)
    else clusters.set(r, [i])
  })

  // 3. 达标判定 + 覆盖/墓碑去重
  const memSets = memoryGramSets(root)
  const tombstones = allSignatures(root).map((s) => ({ sig: s, set: grams(s) }))
  const report: MinerReport = {
    sessionsScanned: files.length,
    sentences: sentenceCount,
    scriptedMessages: scriptedSkipped,
    clusters: clusters.size,
    qualified: 0,
    covered: 0,
    tombstoned: 0,
    proposed: [],
  }
  const proposals = new Map<string, ReturnType<typeof buildProposal>[]>()

  function buildProposal(members: number[], occ: Occurrence[], sessions: Set<string>) {
    // 代表句 = 出现最多的原文
    const freq = new Map<string, number>()
    for (const o of occ) freq.set(o.text, (freq.get(o.text) ?? 0) + 1)
    const rep = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const variants = [...new Set(occ.map((o) => o.text))].filter((t) => t !== rep).slice(0, 3)
    const evidence: InboxEvidence[] = occ
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_EVIDENCE)
      .map((o) => ({
        source: `${shortBucket(o.bucket)}/${o.session.slice(0, 8)}`,
        ts: o.ts,
        text: o.context || o.text, // 带前后文，人才看得懂句子出现的语境
      }))
    const draft = [
      `用户在 ${sessions.size} 个会话里反复输入的约束：`,
      '',
      `> ${rep}`,
      ...(variants.length ? ['', '其他表述：', ...variants.map((v) => `- ${v}`)] : []),
      '',
      '**Why:** 反复手动输入说明记忆系统还没固化它。固化后不必每次再敲。',
    ].join('\n')
    return { rep, sessions: sessions.size, draft, evidence, members }
  }

  for (const members of clusters.values()) {
    const occ = members.flatMap((i) => byNorm.get(norms[i])!.occ)
    const sessions = new Set(occ.map((o) => o.session))
    if (sessions.size < minSessions) continue
    // 来源消息长度中位数 > 400 = 句子寄生在巨型注入 prompt 里，不是人反复敲的约束
    const lens = occ.map((o) => o.msgLen).sort((a, b) => a - b)
    if (lens[Math.floor(lens.length / 2)] > 400) continue
    report.qualified++

    const p = buildProposal(members, occ, sessions)
    // 查重必须用与入库签名同源的代表句（高频原文），否则簇成员顺序一变就绕过墓碑
    const repNormSet = grams(normalize(p.rep))
    // 已被某条记忆覆盖？
    if (memSets.some((m) => containment(repNormSet, m.set) >= MEMORY_COVERED)) {
      report.covered++
      continue
    }
    // 已提过（含被忽略的墓碑）？
    if (tombstones.some((t) => jaccard(repNormSet, t.set) >= TOMBSTONE_JACCARD)) {
      report.tombstoned++
      continue
    }
    // 归属桶 = 出现最多的桶
    const bucketFreq = new Map<string, number>()
    for (const o of occ) bucketFreq.set(o.bucket, (bucketFreq.get(o.bucket) ?? 0) + 1)
    const bucket = [...bucketFreq.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const list = proposals.get(bucket) ?? []
    list.push(p)
    proposals.set(bucket, list)
  }

  // 安全阀：单次提案上限（按会话数取头部），超限说明上游过滤失效，宁可少提也别淹没收件箱
  const MAX_PROPOSALS = 12
  const total = [...proposals.values()].reduce((n, l) => n + l.length, 0)
  if (total > MAX_PROPOSALS) {
    console.error(`[miner] 提案 ${total} 条超上限 ${MAX_PROPOSALS}，按会话数截取头部——上游过滤可能有漏洞，请人工检查`)
    const flat = [...proposals.entries()].flatMap(([b, l]) => l.map((p) => ({ b, p }))).sort((a, b) => b.p.sessions - a.p.sessions)
    proposals.clear()
    for (const { b, p } of flat.slice(0, MAX_PROPOSALS)) {
      const list = proposals.get(b) ?? []
      list.push(p)
      proposals.set(b, list)
    }
  }

  for (const [bucket, list] of proposals) {
    if (!dry) {
      addInboxItems(
        root,
        bucket,
        list.map((p) => ({
          kind: 'repeated-constraint' as const,
          title: p.rep.length > 48 ? p.rep.slice(0, 48) + '…' : p.rep,
          hint: `你在 ${p.sessions} 个会话里反复输入过这句话`,
          draft: p.draft,
          evidence: p.evidence,
          suggestedType: 'feedback' as const,
          signature: normalize(p.rep),
        })),
      )
    }
    for (const p of list) report.proposed.push({ bucket, title: p.rep.slice(0, 60), sessions: p.sessions })
  }
  return report
}

// CLI 入口：npx tsx src/server/miner.ts [--min-sessions N] [--dry]
const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('miner.ts')
if (isMain) {
  const minArg = process.argv.indexOf('--min-sessions')
  const min = minArg >= 0 ? Number(process.argv[minArg + 1]) : MIN_SESSIONS
  const report = mine(PROJECTS_ROOT, min, process.argv.includes('--dry'))
  console.log(JSON.stringify(report, null, 2))
}
