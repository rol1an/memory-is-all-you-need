import type { EntryDetail, GraphPayload, InboxItem, InboxStatus, LensComment, MemType } from '../../shared/types'

export async function fetchGraph(): Promise<GraphPayload> {
  const res = await fetch('/api/graph')
  if (!res.ok) throw new Error(`graph: ${res.status}`)
  return res.json()
}

export async function fetchEntry(id: string): Promise<EntryDetail> {
  const res = await fetch(`/api/entry?id=${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`entry: ${res.status}`)
  return res.json()
}

async function expectOk(res: Response) {
  if (res.ok) return res.json()
  const data = await res.json().catch(() => ({}))
  throw new Error(data.error || `HTTP ${res.status}`)
}

export interface SaveEntryInput {
  slug: string
  bucket?: string
  title?: string
  description?: string
  type?: MemType
  body: string
}

export function saveEntry(input: SaveEntryInput): Promise<{ path: string }> {
  return fetch('/api/entry', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(expectOk)
}

export function deleteEntry(slug: string, bucket: string | 'all'): Promise<{ deleted: string[] }> {
  return fetch(`/api/entry?id=${encodeURIComponent(slug)}&bucket=${encodeURIComponent(bucket)}`, {
    method: 'DELETE',
  }).then(expectOk)
}

export interface CreateEntryInput {
  bucket: string
  slug: string
  title: string
  description: string
  type: MemType
  body: string
}

export function createEntry(input: CreateEntryInput): Promise<{ path: string }> {
  return fetch('/api/entry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(expectOk)
}

export function addLink(from: string, to: string): Promise<{ added: boolean }> {
  return fetch('/api/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  }).then(expectOk)
}

export function fetchComments(slug: string): Promise<LensComment[]> {
  return fetch(`/api/comments?slug=${encodeURIComponent(slug)}`).then(expectOk)
}

export function postComment(input: {
  slug: string
  bucket: string
  quote: string
  comment: string
}): Promise<LensComment> {
  return fetch('/api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(expectOk)
}

export function patchComment(bucket: string, id: string, status: 'pending' | 'done'): Promise<{ ok: boolean }> {
  return fetch('/api/comments', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket, id, status }),
  }).then(expectOk)
}

export function removeComment(bucket: string, id: string): Promise<{ ok: boolean }> {
  return fetch(`/api/comments?bucket=${encodeURIComponent(bucket)}&id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }).then(expectOk)
}

export function fetchInbox(): Promise<InboxItem[]> {
  return fetch('/api/inbox').then(expectOk)
}

export function patchInbox(bucket: string, id: string, status: InboxStatus): Promise<{ ok: boolean }> {
  return fetch('/api/inbox', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket, id, status }),
  }).then(expectOk)
}

/** 订阅服务端的图更新推送，返回取消函数 */
export function subscribe(onGraphChange: () => void, onStatus: (up: boolean) => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let retry: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (closed) return
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    ws.onopen = () => onStatus(true)
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'graph') onGraphChange()
      } catch {
        /* 忽略坏消息 */
      }
    }
    ws.onclose = () => {
      onStatus(false)
      if (!closed) retry = setTimeout(connect, 2000)
    }
  }
  connect()
  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    ws?.close()
  }
}
