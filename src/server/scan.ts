import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import matter from 'gray-matter'
import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import {
  SHELL_RULE,
  type BucketInfo,
  type EntryDetail,
  type GraphPayload,
  type MemLink,
  type MemNode,
  type MemType,
  type Shell,
} from '../shared/types.js'
import { setBucketPrefix, shortBucket } from '../shared/bucket.js'
import type { ReadStats } from './readstats.js'

export const PROJECTS_ROOT =
  process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')

/** home 目录的桶名编码（/ 和 _ → -），server 侧所有短名显示据此剥前缀 */
export const HOME_PREFIX = os.homedir().replace(/[/_]/g, '-')
setBucketPrefix(HOME_PREFIX)

const WIKILINK_RE = /\[\[([^\][\n]+?)\]\]/g

interface RawEntry {
  bucket: string
  slug: string
  file: string
  basename: string
  /** 来自 MEMORY.md 索引的短标题（可能缺失） */
  indexTitle?: string
  headingTitle?: string
  description: string
  type: MemType
  bytes: number
  mtime: number
  outLinks: Map<string, number>
}

function normType(v: unknown): MemType {
  const s = String(v ?? '').trim()
  return s === 'user' || s === 'feedback' || s === 'project' || s === 'reference' ? s : 'unknown'
}

/** MEMORY.md 索引行形如 `- [中文标题](file.md) — hook`，抽出 file→标题 映射 */
function parseIndexTitles(indexPath: string): Map<string, string> {
  const titles = new Map<string, string>()
  let text = ''
  try {
    text = fs.readFileSync(indexPath, 'utf8')
  } catch {
    return titles
  }
  const re = /\[([^\]]+)\]\(([^)]+\.md)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    titles.set(path.basename(m[2]), m[1])
  }
  return titles
}

function firstHeading(body: string): string | undefined {
  const m = body.match(/^#\s+(.+)$/m)
  return m?.[1]?.trim()
}

export function listMemoryDirs(root: string = PROJECTS_ROOT): string[] {
  let buckets: string[] = []
  try {
    buckets = fs.readdirSync(root)
  } catch {
    return []
  }
  return buckets
    .map((b) => path.join(root, b, 'memory'))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory()
      } catch {
        return false
      }
    })
}

function scanEntries(root: string): { entries: RawEntry[]; buckets: BucketInfo[] } {
  const entries: RawEntry[] = []
  const buckets: BucketInfo[] = []

  for (const memDir of listMemoryDirs(root)) {
    const bucket = path.basename(path.dirname(memDir))
    const indexPath = path.join(memDir, 'MEMORY.md')
    const titles = parseIndexTitles(indexPath)
    let indexBytes = 0
    let indexLines = 0
    try {
      const idx = fs.readFileSync(indexPath, 'utf8')
      indexBytes = Buffer.byteLength(idx)
      indexLines = idx.split('\n').length
    } catch {
      /* 桶可以没有索引 */
    }

    let files: string[] = []
    try {
      files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    } catch {
      continue
    }

    for (const f of files) {
      const full = path.join(memDir, f)
      let raw: string
      let stat: fs.Stats
      try {
        raw = fs.readFileSync(full, 'utf8')
        stat = fs.statSync(full)
      } catch {
        continue
      }
      let fm: matter.GrayMatterFile<string>
      try {
        fm = matter(raw)
      } catch {
        fm = { content: raw, data: {} } as matter.GrayMatterFile<string>
      }
      const data = fm.data as Record<string, any>
      const slug = String(data.name || f.replace(/\.md$/, ''))
      const outLinks = new Map<string, number>()
      let m: RegExpExecArray | null
      while ((m = WIKILINK_RE.exec(fm.content))) {
        const target = m[1].trim()
        if (target && target !== slug) outLinks.set(target, (outLinks.get(target) ?? 0) + 1)
      }
      entries.push({
        bucket,
        slug,
        file: full,
        basename: f,
        indexTitle: titles.get(f),
        headingTitle: firstHeading(fm.content),
        description: String(data.description ?? ''),
        type: normType(data.metadata?.type),
        bytes: stat.size,
        mtime: stat.mtimeMs,
        outLinks,
      })
    }

    buckets.push({
      id: bucket,
      label: shortBucket(bucket) || bucket,
      dir: memDir,
      count: files.length,
      indexBytes,
      indexLines,
    })
  }
  return { entries, buckets }
}

export function buildGraph(root: string = PROJECTS_ROOT, readStats: ReadStats = new Map()): GraphPayload {
  const { entries, buckets } = scanEntries(root)

  // 同 slug 跨桶副本合并为一个节点：同一条经验只画一个点
  const bySlug = new Map<string, RawEntry[]>()
  for (const e of entries) {
    const list = bySlug.get(e.slug) ?? []
    list.push(e)
    bySlug.set(e.slug, list)
  }

  interface Merged {
    slug: string
    primary: RawEntry
    copies: RawEntry[]
    outLinks: Map<string, number>
  }
  const merged = new Map<string, Merged>()
  for (const [slug, copies] of bySlug) {
    const sorted = [...copies].sort((a, b) => b.mtime - a.mtime)
    const outLinks = new Map<string, number>()
    for (const c of copies) {
      for (const [t, w] of c.outLinks) outLinks.set(t, (outLinks.get(t) ?? 0) + w)
    }
    merged.set(slug, { slug, primary: sorted[0], copies: sorted, outLinks })
  }

  // 链接聚合（slug → slug），落空的挂占位节点
  const linkAgg = new Map<string, MemLink>()
  const placeholderSlugs = new Set<string>()
  const inDegree = new Map<string, Set<string>>()

  for (const m of merged.values()) {
    for (const [target, weight] of m.outLinks) {
      const key = `${m.slug} ${target}`
      const known = merged.has(target)
      if (!known) placeholderSlugs.add(target)
      const prev = linkAgg.get(key)
      if (prev) {
        prev.weight += weight
      } else {
        const cross =
          known &&
          !merged.get(target)!.copies.some((tc) => m.copies.some((sc) => sc.bucket === tc.bucket))
        linkAgg.set(key, {
          source: m.slug,
          target,
          weight,
          cross: cross || undefined,
          dangling: !known || undefined,
        })
      }
      if (known) {
        const s = inDegree.get(target) ?? new Set<string>()
        s.add(m.slug)
        inDegree.set(target, s)
      }
    }
  }

  // 分层 = 运行时重要性：agent 实际打开正文的会话数（占位节点固定外核）
  const shellOf = (readSessions: number): Shell =>
    readSessions >= SHELL_RULE.kernel ? 0 : readSessions >= SHELL_RULE.mid ? 1 : 2

  // Louvain 社区发现（只对真实节点）
  const g = new Graph({ type: 'undirected', multi: false })
  for (const slug of merged.keys()) g.addNode(slug)
  for (const l of linkAgg.values()) {
    if (l.dangling || l.source === l.target) continue
    if (!g.hasEdge(l.source, l.target)) g.addEdge(l.source, l.target, { weight: l.weight })
  }
  let communities: Record<string, number> = {}
  try {
    communities = louvain(g, { getEdgeWeight: 'weight' }) as Record<string, number>
  } catch {
    /* 空图/无边时跳过 */
  }

  const nodes: MemNode[] = [...merged.values()].map((m) => {
    const inD = inDegree.get(m.slug)?.size ?? 0
    const title =
      m.copies.find((c) => c.indexTitle)?.indexTitle ||
      m.copies.find((c) => c.headingTitle)?.headingTitle ||
      m.slug
    // 读取事实按副本聚合：任一桶的副本被读都算这条记忆被读
    const sessions = new Set<string>()
    let lastRead = 0
    for (const c of m.copies) {
      const s = readStats.get(`${c.bucket}/${c.basename}`)
      if (!s) continue
      for (const sid of s.sessions) sessions.add(sid)
      lastRead = Math.max(lastRead, s.lastRead)
    }
    return {
      id: m.slug,
      slug: m.slug,
      bucket: m.primary.bucket,
      buckets: [...new Set(m.copies.map((c) => c.bucket))],
      title,
      description: m.primary.description,
      type: m.primary.type,
      bytes: m.primary.bytes,
      mtime: m.primary.mtime,
      inDegree: inD,
      outDegree: m.outLinks.size,
      readSessions: sessions.size,
      lastRead,
      shell: shellOf(sessions.size),
      community: communities[m.slug] ?? -1,
    }
  })

  for (const slug of placeholderSlugs) {
    nodes.push({
      id: slug,
      slug,
      bucket: '~',
      buckets: [],
      title: slug,
      description: '悬空链接：有记忆引用它，但对应文件还没写',
      type: 'unknown',
      bytes: 0,
      mtime: 0,
      inDegree: inDegree.get(slug)?.size ?? 0,
      outDegree: 0,
      readSessions: 0,
      lastRead: 0,
      shell: 2,
      community: -1,
      placeholder: true,
    })
  }

  const links = [...linkAgg.values()]
  const orphans = nodes.filter((n) => !n.placeholder && n.inDegree === 0 && n.outDegree === 0).length

  return {
    nodes,
    links,
    buckets,
    stats: {
      files: entries.length,
      merged: merged.size,
      links: links.length,
      orphans,
      placeholders: placeholderSlugs.size,
    },
    homePrefix: HOME_PREFIX,
    generatedAt: Date.now(),
  }
}

export function readEntry(root: string, slug: string): EntryDetail | null {
  if (!slug || slug.includes('..') || slug.includes('/')) return null
  const copies: { bucket: string; path: string; bytes: number; mtime: number; body: string; fm: Record<string, unknown>; heading?: string }[] = []
  for (const memDir of listMemoryDirs(root)) {
    const bucket = path.basename(path.dirname(memDir))
    let files: string[] = []
    try {
      files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    } catch {
      continue
    }
    for (const f of files) {
      const full = path.join(memDir, f)
      try {
        const raw = fs.readFileSync(full, 'utf8')
        const fm = matter(raw)
        const name = String((fm.data as any).name || path.basename(f, '.md'))
        if (name !== slug) continue
        const stat = fs.statSync(full)
        copies.push({
          bucket,
          path: full,
          bytes: stat.size,
          mtime: stat.mtimeMs,
          body: fm.content,
          fm: fm.data as Record<string, unknown>,
          heading: firstHeading(fm.content),
        })
      } catch {
        continue
      }
    }
  }
  if (copies.length === 0) return null
  copies.sort((a, b) => b.mtime - a.mtime)
  const latest = copies[0]
  return {
    id: slug,
    title: latest.heading || slug,
    frontmatter: latest.fm,
    body: latest.body,
    bytes: latest.bytes,
    mtime: latest.mtime,
    path: latest.path,
    copies: copies.map(({ bucket, path: p, bytes, mtime }) => ({ bucket, path: p, bytes, mtime })),
  }
}
