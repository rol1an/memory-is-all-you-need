import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { PROJECTS_ROOT } from './scan.js'

/**
 * 从会话 transcript（JSONL）里挖真实读取事实：
 * agent 每次用 Read 工具打开 memory/*.md 都留痕在 assistant 的 tool_use 里。
 * 这是"哪些记忆真的被 agent 读取"的唯一确定性数据源（索引注入不走 Read，不在此列）。
 */

export interface ReadStat {
  /** 打开过此文件正文的不同会话 */
  sessions: Set<string>
  /** 最后一次被读，epoch ms */
  lastRead: number
}

/** key = `${bucket}/${basename}` */
export type ReadStats = Map<string, ReadStat>

const MEM_PATH_RE = /\.claude\/projects\/([^/\s"]+)\/memory\/([^/\s"]+\.md)/

interface FileContrib {
  mtimeMs: number
  size: number
  /** key -> 该文件里最后一次读取时间 */
  keys: Map<string, number>
}

const fileCache = new Map<string, FileContrib>()

function listTranscripts(root: string): { file: string; session: string }[] {
  const out: { file: string; session: string }[] = []
  let buckets: string[] = []
  try {
    buckets = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const b of buckets) {
    const dir = path.join(root, b)
    let items: string[] = []
    try {
      items = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const it of items) {
      const full = path.join(dir, it)
      if (it.endsWith('.jsonl')) {
        out.push({ file: full, session: it.replace(/\.jsonl$/, '') })
        continue
      }
      // 会话目录下的 subagent transcript 也算该会话的读取
      const sub = path.join(full, 'subagents')
      try {
        if (fs.statSync(sub).isDirectory()) {
          const walk = (d: string) => {
            for (const f of fs.readdirSync(d)) {
              const p = path.join(d, f)
              try {
                const st = fs.statSync(p)
                if (st.isDirectory()) walk(p)
                else if (f.endsWith('.jsonl')) out.push({ file: p, session: it })
              } catch {
                /* 忽略消失的文件 */
              }
            }
          }
          walk(sub)
        }
      } catch {
        /* 没有 subagents 目录 */
      }
    }
  }
  return out
}

async function parseFile(file: string): Promise<Map<string, number>> {
  const keys = new Map<string, number>()
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    // 便宜的预筛，避免对每行做 JSON.parse
    if (!line.includes('"Read"') || !line.includes('/memory/')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const content = o?.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c?.type !== 'tool_use' || c?.name !== 'Read') continue
      const fp = String(c?.input?.file_path ?? '')
      const m = MEM_PATH_RE.exec(fp)
      if (!m) continue
      const key = `${m[1]}/${m[2]}`
      const ts = Date.parse(o?.timestamp ?? '') || 0
      keys.set(key, Math.max(keys.get(key) ?? 0, ts))
    }
  }
  return keys
}

export interface TranscriptCensus {
  /** 桶 → 主会话数（桶目录下顶层 .jsonl，与 ReadStats 的会话口径一致） */
  perBucket: Map<string, number>
  sessions: number
  windowDays: number
  /** 打开过至少一条记忆正文的主会话数（ReadStats 全部会话 id 的并集） */
  reading: number
}

/** 便宜的 stat 级普查：不读内容，只数会话文件和时间窗口 */
export function censusTranscripts(stats: ReadStats, root: string = PROJECTS_ROOT): TranscriptCensus {
  const perBucket = new Map<string, number>()
  let minMt = Infinity
  let maxMt = -Infinity
  let sessions = 0
  let buckets: string[] = []
  try {
    buckets = fs.readdirSync(root)
  } catch {
    /* 目录不存在 → 空普查 */
  }
  for (const b of buckets) {
    const dir = path.join(root, b)
    let items: string[] = []
    try {
      items = fs.readdirSync(dir)
    } catch {
      continue
    }
    let n = 0
    for (const it of items) {
      if (!it.endsWith('.jsonl')) continue
      try {
        const mt = fs.statSync(path.join(dir, it)).mtimeMs
        minMt = Math.min(minMt, mt)
        maxMt = Math.max(maxMt, mt)
      } catch {
        continue
      }
      n++
    }
    if (n > 0) perBucket.set(b, n)
    sessions += n
  }
  // 只算读过条目正文的会话；MEMORY.md 是索引，每次会话都注入，读它不算"用了记忆"
  const readingSessions = new Set<string>()
  for (const [key, s] of stats) {
    if (key.endsWith('/MEMORY.md')) continue
    for (const sid of s.sessions) readingSessions.add(sid)
  }
  return {
    perBucket,
    sessions,
    windowDays: sessions > 0 ? Math.max(1, Math.ceil((maxMt - minMt) / 86_400_000)) : 0,
    reading: readingSessions.size,
  }
}

/** 增量扫描（按 mtime+size 缓存，只重读变过的 transcript），返回聚合结果 */
export async function refreshReadStats(root: string = PROJECTS_ROOT): Promise<ReadStats> {
  const transcripts = listTranscripts(root)
  const seen = new Set<string>()
  for (const { file } of transcripts) {
    seen.add(file)
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    const cached = fileCache.get(file)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue
    try {
      fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, keys: await parseFile(file) })
    } catch {
      /* 单个坏文件不影响整体 */
    }
  }
  for (const k of fileCache.keys()) if (!seen.has(k)) fileCache.delete(k)

  const stats: ReadStats = new Map()
  const sessionOf = new Map(transcripts.map((t) => [t.file, t.session]))
  for (const [file, contrib] of fileCache) {
    const session = sessionOf.get(file)
    if (!session) continue
    for (const [key, ts] of contrib.keys) {
      let s = stats.get(key)
      if (!s) {
        s = { sessions: new Set(), lastRead: 0 }
        stats.set(key, s)
      }
      s.sessions.add(session)
      s.lastRead = Math.max(s.lastRead, ts)
    }
  }
  return stats
}
