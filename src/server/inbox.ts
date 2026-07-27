import fs from 'node:fs'
import path from 'node:path'
import { listMemoryDirs, PROJECTS_ROOT } from './scan.js'
import { MutateError } from './mutate.js'
import type { InboxItem, InboxStatus } from '../shared/types.js'

/**
 * 记忆候选收件箱：每桶一个 .lens-inbox.jsonl（非 .md，图扫描与监听不感知）。
 * 供给侧管线只写 pending；人在观测台审：接受(accepted) / 忽略(dismissed)；
 * SessionStart hook 把 accepted 注入给 CC，CC 写成记忆后标 done。
 * dismissed/done 都保留作墓碑——挖掘器靠 signature 不再重复提案。
 */

const FILE = '.lens-inbox.jsonl'

function inboxPath(root: string, bucket: string): string {
  const dir = listMemoryDirs(root).find((d) => path.basename(path.dirname(d)) === bucket)
  if (!dir) throw new MutateError(`记忆桶不存在: ${bucket}`, 404)
  return path.join(dir, FILE)
}

function readFileItems(file: string): InboxItem[] {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: InboxItem[] = []
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

export function listInbox(root: string = PROJECTS_ROOT): InboxItem[] {
  const all: InboxItem[] = []
  for (const dir of listMemoryDirs(root)) {
    all.push(...readFileItems(path.join(dir, FILE)))
  }
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

/** 全部签名（含墓碑），供给侧管线去重用 */
export function allSignatures(root: string = PROJECTS_ROOT): string[] {
  return listInbox(root).map((i) => i.signature).filter(Boolean)
}

export function addInboxItems(root: string, bucket: string, items: Omit<InboxItem, 'id' | 'createdAt' | 'status' | 'bucket'>[]): InboxItem[] {
  if (items.length === 0) return []
  const file = inboxPath(root, bucket)
  const created = items.map((it, i) => ({
    ...it,
    id: `i-${Date.now()}-${i}`,
    bucket,
    status: 'pending' as InboxStatus,
    createdAt: Date.now(),
  }))
  fs.appendFileSync(file, created.map((c) => JSON.stringify(c)).join('\n') + '\n')
  return created
}

export function setInboxStatus(root: string, bucket: string, id: string, status: InboxStatus): void {
  const file = inboxPath(root, bucket)
  const items = readFileItems(file)
  const hit = items.find((c) => c.id === id)
  if (!hit) throw new MutateError(`收件箱条目不存在: ${id}`, 404)
  hit.status = status
  fs.writeFileSync(file, items.map((c) => JSON.stringify(c)).join('\n') + '\n')
}

export function deleteInboxItem(root: string, bucket: string, id: string): void {
  const file = inboxPath(root, bucket)
  const items = readFileItems(file)
  const kept = items.filter((c) => c.id !== id)
  if (kept.length === items.length) throw new MutateError(`收件箱条目不存在: ${id}`, 404)
  fs.writeFileSync(file, kept.length ? kept.map((c) => JSON.stringify(c)).join('\n') + '\n' : '')
}
