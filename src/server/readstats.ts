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
