import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { MemType } from '../shared/types.js'
import { listMemoryDirs } from './scan.js'

const SLUG_RE = /^[\w][\w.-]*$/

export class MutateError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

function assertSlug(slug: string) {
  if (!SLUG_RE.test(slug) || slug.includes('..')) throw new MutateError(`非法 slug: ${slug}`)
}

function bucketDir(root: string, bucket: string): string {
  const dir = listMemoryDirs(root).find((d) => path.basename(path.dirname(d)) === bucket)
  if (!dir) throw new MutateError(`记忆桶不存在: ${bucket}`, 404)
  return dir
}

/** 在桶内找到 slug 对应的文件（frontmatter name 优先于文件名） */
function resolveFile(memDir: string, slug: string): string | null {
  const direct = path.join(memDir, `${slug}.md`)
  if (fs.existsSync(direct)) return direct
  for (const f of fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')) {
    const full = path.join(memDir, f)
    try {
      const fm = matter(fs.readFileSync(full, 'utf8'))
      if (String((fm.data as any).name || '') === slug) return full
    } catch {
      continue
    }
  }
  return null
}

/** 最新副本所在桶（未指定桶时的编辑/连线目标） */
function newestCopy(root: string, slug: string): { memDir: string; file: string } {
  let best: { memDir: string; file: string; mtime: number } | null = null
  for (const memDir of listMemoryDirs(root)) {
    const file = resolveFile(memDir, slug)
    if (!file) continue
    const mtime = fs.statSync(file).mtimeMs
    if (!best || mtime > best.mtime) best = { memDir, file, mtime }
  }
  if (!best) throw new MutateError(`条目不存在: ${slug}`, 404)
  return best
}

// ── MEMORY.md 索引同步 ────────────────────────────────

function indexPathOf(memDir: string) {
  return path.join(memDir, 'MEMORY.md')
}

function removeIndexLine(memDir: string, basename: string) {
  const idx = indexPathOf(memDir)
  if (!fs.existsSync(idx)) return
  const lines = fs.readFileSync(idx, 'utf8').split('\n')
  const kept = lines.filter((l) => !l.includes(`](${basename})`))
  if (kept.length !== lines.length) fs.writeFileSync(idx, kept.join('\n'))
}

function upsertIndexLine(memDir: string, basename: string, title: string, hook: string) {
  const idx = indexPathOf(memDir)
  const line = `- [${title}](${basename}) — ${hook.replace(/\n/g, ' ').slice(0, 120)}`
  if (!fs.existsSync(idx)) {
    fs.writeFileSync(idx, `# Memory Index\n\n${line}\n`)
    return
  }
  const lines = fs.readFileSync(idx, 'utf8').split('\n')
  const at = lines.findIndex((l) => l.includes(`](${basename})`))
  if (at >= 0) {
    lines[at] = line
  } else {
    // 追加到最后一个列表行之后，没有列表就放文件末尾
    let lastList = -1
    for (let i = 0; i < lines.length; i++) if (/^\s*- /.test(lines[i])) lastList = i
    lines.splice(lastList >= 0 ? lastList + 1 : lines.length, 0, line)
  }
  fs.writeFileSync(idx, lines.join('\n'))
}

// ── 四个操作 ────────────────────────────────────────

export interface SaveInput {
  slug: string
  bucket?: string
  title?: string
  description?: string
  type?: MemType
  body: string
}

export function saveEntry(root: string, input: SaveInput): { path: string } {
  assertSlug(input.slug)
  const { memDir, file } = input.bucket
    ? (() => {
        const d = bucketDir(root, input.bucket!)
        const f = resolveFile(d, input.slug)
        if (!f) throw new MutateError(`桶 ${input.bucket} 里没有条目 ${input.slug}`, 404)
        return { memDir: d, file: f }
      })()
    : newestCopy(root, input.slug)

  const fm = matter(fs.readFileSync(file, 'utf8'))
  const data = fm.data as Record<string, any>
  if (input.description !== undefined) data.description = input.description
  if (input.type !== undefined) {
    data.metadata = { ...(data.metadata ?? {}), type: input.type }
  }
  fs.writeFileSync(file, matter.stringify(input.body.replace(/^\n+/, ''), data))
  if (input.title) {
    upsertIndexLine(memDir, path.basename(file), input.title, String(data.description ?? ''))
  }
  return { path: file }
}

export function deleteEntry(root: string, slug: string, bucket: string | 'all'): { deleted: string[] } {
  assertSlug(slug)
  const targets: { memDir: string; file: string }[] = []
  if (bucket === 'all') {
    for (const memDir of listMemoryDirs(root)) {
      const file = resolveFile(memDir, slug)
      if (file) targets.push({ memDir, file })
    }
  } else {
    const memDir = bucketDir(root, bucket)
    const file = resolveFile(memDir, slug)
    if (file) targets.push({ memDir, file })
  }
  if (targets.length === 0) throw new MutateError(`条目不存在: ${slug}`, 404)
  for (const { memDir, file } of targets) {
    fs.unlinkSync(file)
    removeIndexLine(memDir, path.basename(file))
  }
  return { deleted: targets.map((t) => t.file) }
}

export interface CreateInput {
  bucket: string
  slug: string
  title: string
  description: string
  type: MemType
  body: string
}

export function createEntry(root: string, input: CreateInput): { path: string } {
  assertSlug(input.slug)
  if (!input.title.trim()) throw new MutateError('标题不能为空')
  if (!input.description.trim()) throw new MutateError('描述不能为空（一句话概括，会进 MEMORY.md 索引）')
  const memDir = bucketDir(root, input.bucket)
  if (resolveFile(memDir, input.slug)) throw new MutateError(`条目已存在: ${input.slug}`, 409)
  const file = path.join(memDir, `${input.slug}.md`)
  const content = matter.stringify(input.body.replace(/^\n+/, ''), {
    name: input.slug,
    description: input.description,
    metadata: { type: input.type },
  })
  fs.writeFileSync(file, content, { flag: 'wx' })
  upsertIndexLine(memDir, `${input.slug}.md`, input.title, input.description)
  return { path: file }
}

/** 在 from 的正文末尾追加 [[to]]；幂等——正文里已有该链接就什么都不做 */
export function addLink(root: string, fromSlug: string, toSlug: string): { added: boolean; path: string } {
  assertSlug(fromSlug)
  assertSlug(toSlug)
  if (fromSlug === toSlug) throw new MutateError('不能链接到自己')
  const { file } = newestCopy(root, fromSlug)
  const raw = fs.readFileSync(file, 'utf8')
  const fm = matter(raw)
  if (fm.content.includes(`[[${toSlug}]]`)) return { added: false, path: file }

  let body = fm.content.replace(/\s+$/, '')
  const relatedLine = body.match(/^相关[:：].*$/m)
  if (relatedLine) {
    body = body.replace(relatedLine[0], `${relatedLine[0]} [[${toSlug}]]`)
  } else {
    body = `${body}\n\n相关：[[${toSlug}]]`
  }
  fs.writeFileSync(file, matter.stringify(body + '\n', fm.data))
  return { added: true, path: file }
}
