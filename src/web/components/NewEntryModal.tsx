import { useEffect, useState } from 'react'
import type { BucketInfo, MemType } from '../../shared/types'
import { createEntry } from '../lib/api'
import { TYPE_LABEL } from '../lib/palette'

const TYPES: MemType[] = ['feedback', 'user', 'project', 'reference']
const BODY_TEMPLATE = `<一句话说清这条经验>

**Why:** <为什么重要，删了会踩什么坑>

**How to apply:** <下次怎么用>
`

export interface NewEntryPrefill {
  slug?: string
  bucket?: string
}

interface Props {
  buckets: BucketInfo[]
  prefill: NewEntryPrefill
  onClose: () => void
  onCreated: (slug: string) => void
}

export default function NewEntryModal({ buckets, prefill, onClose, onCreated }: Props) {
  const [bucket, setBucket] = useState(prefill.bucket || buckets[0]?.id || '')
  const [slug, setSlug] = useState(prefill.slug || '')
  const [title, setTitle] = useState('')
  const [type, setType] = useState<MemType>('feedback')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState(BODY_TEMPLATE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const slugOk = /^[\w][\w.-]*$/.test(slug)

  const submit = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    createEntry({ bucket, slug, title, description, type, body })
      .then(() => onCreated(slug))
      .catch((e) => {
        setError(String(e.message || e))
        setBusy(false)
      })
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="新建记忆">
        <h2 className="modal-title">新建记忆</h2>

        <div className="form-row two">
          <label>
            <span>记忆桶</span>
            <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label || '(根)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>类型</span>
            <select value={type} onChange={(e) => setType(e.target.value as MemType)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="form-row">
          <label>
            <span>slug（文件名，短横线小写）</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="api-rate-limit-facts"
              className={slug && !slugOk ? 'invalid' : ''}
            />
          </label>
        </div>

        <div className="form-row">
          <label>
            <span>标题（进 MEMORY.md 索引的中文短标题）</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="API 限流阈值实测" />
          </label>
        </div>

        <div className="form-row">
          <label>
            <span>描述（一句话概括）</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="用于索引行 — 后面的钩子" />
          </label>
        </div>

        <div className="form-row">
          <label>
            <span>正文</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} spellCheck={false} />
          </label>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !slugOk || !slug || !title.trim() || !description.trim()}>
            {busy ? '写入中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
