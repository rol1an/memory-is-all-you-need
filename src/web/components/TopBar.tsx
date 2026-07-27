import { useEffect, useRef, useState } from 'react'
import type { MemNode } from '../../shared/types'
import { shortBucket } from '../../shared/bucket'
import { TYPE_COLOR } from '../lib/palette'

interface Props {
  nodes: MemNode[]
  live: boolean
  inboxPending: number
  onFocus: (id: string) => void
  onNewEntry: () => void
  onInbox: () => void
  onShowcase: () => void
}

export default function TopBar({ nodes, live, inboxPending, onFocus, onNewEntry, onInbox, onShowcase }: Props) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const needle = q.trim().toLowerCase()
  const matches = needle
    ? nodes
        .filter(
          (n) =>
            !n.placeholder &&
            (n.title.toLowerCase().includes(needle) ||
              n.slug.toLowerCase().includes(needle) ||
              n.description.toLowerCase().includes(needle)),
        )
        .slice(0, 12)
    : []

  const pick = (id: string) => {
    onFocus(id)
    setOpen(false)
    setQ('')
  }

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          ◉
        </span>
        <span className="brand-name">Memory Is All You Need</span>
        <span className="brand-sub">记忆观测台</span>
      </div>

      <div className="search-box" ref={boxRef}>
        <input
          type="search"
          placeholder="搜索记忆（标题 / slug / 描述）"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches.length > 0) pick(matches[0].id)
            if (e.key === 'Escape') setOpen(false)
          }}
        />
        {open && matches.length > 0 && (
          <ul className="search-results">
            {matches.map((n) => (
              <li key={n.id}>
                <button onClick={() => pick(n.id)}>
                  <span className="dot" style={{ background: TYPE_COLOR[n.type] }} />
                  <span className="result-title">{n.title}</span>
                  <span className="result-bucket">{shortBucket(n.bucket)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && needle && matches.length === 0 && (
          <ul className="search-results">
            <li className="search-empty">没有匹配的记忆——试试更短的关键词</li>
          </ul>
        )}
      </div>

      <div className="topbar-right">
        <button className="btn ghost inbox-btn" onClick={onInbox}>
          收件箱
          {inboxPending > 0 && <span className="inbox-badge">{inboxPending}</span>}
        </button>
        <button className="btn ghost" onClick={onNewEntry}>
          ＋ 新建记忆
        </button>
        <button className="btn ghost" onClick={onShowcase} title="回到星系展示">
          ✦ 展示
        </button>
        <span className={live ? 'live-dot on' : 'live-dot'} title={live ? '监听记忆目录中' : '连接断开，重连中'} />
        <span className="live-label">{live ? '实时监听' : '重连中…'}</span>
      </div>
    </header>
  )
}
