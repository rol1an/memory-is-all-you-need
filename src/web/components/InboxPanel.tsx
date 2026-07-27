import { useState } from 'react'
import type { InboxItem } from '../../shared/types'
import { shortBucket } from '../../shared/bucket'
import { TYPE_COLOR, TYPE_LABEL, timeAgo } from '../lib/palette'

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  'repeated-constraint': '重复约束',
  feishu: '飞书',
}

interface Props {
  items: InboxItem[]
  onClose: () => void
  onStatus: (item: InboxItem, status: 'accepted' | 'dismissed' | 'pending') => void
}

export default function InboxPanel({ items, onClose, onStatus }: Props) {
  const [showHandled, setShowHandled] = useState(false)
  const pending = items.filter((i) => i.status === 'pending')
  const accepted = items.filter((i) => i.status === 'accepted')
  const handled = items.filter((i) => i.status === 'done' || i.status === 'dismissed')

  const card = (item: InboxItem) => (
    <li key={item.id} className={`inbox-card ${item.status}`}>
      <div className="inbox-head">
        <span className="badge">{KIND_LABEL[item.kind]}</span>
        <span className="badge bucket-badge">{shortBucket(item.bucket) || '(根)'}</span>
        <span
          className="badge type-badge"
          style={{ color: TYPE_COLOR[item.suggestedType], borderColor: TYPE_COLOR[item.suggestedType] }}
        >
          {TYPE_LABEL[item.suggestedType]}
        </span>
        <span className="inbox-time">{timeAgo(item.createdAt)}</span>
      </div>
      <h4 className="inbox-title">{item.title}</h4>
      {item.hint && <p className="inbox-hint">{item.hint}</p>}
      <details className="inbox-evidence">
        <summary>草稿全文{item.evidence.length > 0 ? ` · 证据 ${item.evidence.length} 条` : ''}</summary>
        <pre className="inbox-draft">{item.draft}</pre>
        {item.evidence.length > 0 && (
          <ul>
            {item.evidence.map((e, i) => (
              <li key={i}>
                <span className="evidence-source">{e.source}</span> {e.text}
              </li>
            ))}
          </ul>
        )}
      </details>
      <div className="inbox-actions">
        {item.status === 'pending' && (
          <>
            <button className="btn primary" onClick={() => onStatus(item, 'accepted')}>
              接受
            </button>
            <button className="btn ghost" onClick={() => onStatus(item, 'dismissed')}>
              忽略
            </button>
          </>
        )}
        {item.status === 'accepted' && (
          <>
            <span className="status-chip">已接受 · 待 CC 写入</span>
            <button className="btn ghost" onClick={() => onStatus(item, 'pending')}>
              撤回
            </button>
          </>
        )}
        {item.status === 'done' && <span className="status-chip done">已写入记忆</span>}
        {item.status === 'dismissed' && <span className="status-chip dim">已忽略（不再重复提案）</span>}
      </div>
    </li>
  )

  return (
    <div className="drawer inbox-panel" role="dialog" aria-label="记忆候选收件箱">
      <div className="drawer-head">
        <h2 className="drawer-title" style={{ margin: 0 }}>
          收件箱 <span className="inbox-count">{pending.length} 待审</span>
        </h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭收件箱">
          ✕
        </button>
      </div>
      <p className="panel-hint">
        供给侧管线的记忆候选：重复约束来自历史会话挖掘（零模型），飞书候选由内网弱模型起草。接受后由下次
        Claude Code 会话正式写入；忽略会留墓碑、同类内容不再提案。
      </p>

      {pending.length === 0 && accepted.length === 0 && (
        <div className="placeholder-note">
          收件箱是空的。跑一轮采集：<code>npm run mine</code>（会话约束）或 <code>npm run scan:feishu</code>（飞书）。
        </div>
      )}

      <ul className="inbox-list">{[...pending, ...accepted].map(card)}</ul>

      {handled.length > 0 && (
        <div className="inbox-handled">
          <button className="btn ghost" onClick={() => setShowHandled((v) => !v)}>
            {showHandled ? '收起' : `已处理 · ${handled.length}`}
          </button>
          {showHandled && <ul className="inbox-list">{handled.map(card)}</ul>}
        </div>
      )}
    </div>
  )
}
