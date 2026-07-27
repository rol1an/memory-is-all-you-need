import fs from 'node:fs'
import path from 'node:path'
import { listMemoryDirs, PROJECTS_ROOT } from './scan.js'
import { MutateError } from './mutate.js'
import type { LensComment } from '../shared/types.js'

/**
 * 记忆评论：人对某条记忆（可带选中引文）留修改意图，
 * 下次 Claude Code 会话由 SessionStart hook 注入待办，CC 改完把 status 标为 done。
 * 存储 = 每桶一个 .lens-comments.jsonl（非 .md，扫描器与文件监听都不会碰它）。
 */

const FILE = '.lens-comments.jsonl'

function commentsPath(root: string, bucket: string): string {
  const dir = listMemoryDirs(root).find((d) => path.basename(path.dirname(d)) === bucket)
  if (!dir) throw new MutateError(`记忆桶不存在: ${bucket}`, 404)
  return path.join(dir, FILE)
}

function readFileComments(file: string): LensComment[] {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: LensComment[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

export function listComments(root: string = PROJECTS_ROOT, slug?: string): LensComment[] {
  const all: LensComment[] = []
  for (const dir of listMemoryDirs(root)) {
    all.push(...readFileComments(path.join(dir, FILE)))
  }
  const filtered = slug ? all.filter((c) => c.slug === slug) : all
  return filtered.sort((a, b) => b.createdAt - a.createdAt)
}

export function addComment(
  root: string,
  input: { slug: string; bucket: string; quote: string; comment: string },
): LensComment {
  if (!input.comment.trim()) throw new MutateError('评论内容不能为空')
  const c: LensComment = {
    id: `c-${Date.now()}-${process.hrtime.bigint() % 1000n}`,
    slug: input.slug,
    bucket: input.bucket,
    quote: input.quote.slice(0, 500),
    comment: input.comment.trim(),
    createdAt: Date.now(),
    status: 'pending',
  }
  fs.appendFileSync(commentsPath(root, input.bucket), JSON.stringify(c) + '\n')
  return c
}

export function setCommentStatus(root: string, bucket: string, id: string, status: 'pending' | 'done'): void {
  const file = commentsPath(root, bucket)
  const items = readFileComments(file)
  const hit = items.find((c) => c.id === id)
  if (!hit) throw new MutateError(`评论不存在: ${id}`, 404)
  hit.status = status
  if (status === 'done') hit.doneAt = Date.now()
  fs.writeFileSync(file, items.map((c) => JSON.stringify(c)).join('\n') + '\n')
}

export function deleteComment(root: string, bucket: string, id: string): void {
  const file = commentsPath(root, bucket)
  const items = readFileComments(file)
  const kept = items.filter((c) => c.id !== id)
  if (kept.length === items.length) throw new MutateError(`评论不存在: ${id}`, 404)
  fs.writeFileSync(file, kept.length ? kept.map((c) => JSON.stringify(c)).join('\n') + '\n' : '')
}
