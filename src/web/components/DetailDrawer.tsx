import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  SHELL_RULE,
  type EntryDetail,
  type LensComment,
  type MemLink,
  type MemNode,
  type MemType,
} from '../../shared/types'
import { shortBucket } from '../../shared/bucket'
import {
  addLink,
  deleteEntry,
  fetchComments,
  fetchEntry,
  patchComment,
  postComment,
  removeComment,
  saveEntry,
} from '../lib/api'
import { SHELL_LABEL, TYPE_COLOR, TYPE_LABEL, timeAgo } from '../lib/palette'

const TYPES: MemType[] = ['feedback', 'user', 'project', 'reference']

interface Props {
  node: MemNode
  nodes: MemNode[]
  links: MemLink[]
  onClose: () => void
  onJump: (id: string) => void
  onCreatePlaceholder: (slug: string, bucket?: string) => void
}

type Mode = 'view' | 'edit' | 'link' | 'delete' | 'comment'

/** [[slug]] → markdown 链接，点击跳到对应节点 */
function preprocessWikilinks(body: string): string {
  return body.replace(/\[\[([^\][\n]+?)\]\]/g, (_, slug) => `[${slug}](mem:${encodeURIComponent(slug)})`)
}

/**
 * 按全角句读符拆分，但绝不切进行内语法内部：
 * 反引号代码、**加粗** 配对、各类括号（含 markdown 链接的 []()）里的 。； 一律不作为切点。
 */
function splitClauses(text: string, seps: string): string[] {
  const OPEN = '（(【[「《'
  const CLOSE = '）)】]」》'
  const parts: string[] = []
  let start = 0
  let inCode = false
  let boldMarks = 0
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '`') {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    if (ch === '*' && text[i + 1] === '*') {
      boldMarks++
      i++
      continue
    }
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1)
    else if (seps.includes(ch) && depth === 0 && boldMarks % 2 === 0) {
      parts.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) parts.push(text.slice(start))
  return parts.map((s) => s.trim()).filter(Boolean)
}

/** 去掉句尾的枚举分号（转成列表后分号已无意义） */
const stripSemi = (s: string) => s.replace(/[；;]$/, '')

/**
 * 易读模式：纯排版变换，不改一个字（仅移动换行、去枚举分号）。
 * 电报体的两种密集结构分别处理：
 * ； 枚举 → 真列表（并列事实竖排）；。 长句连缀 → 同段内硬换行（保住段落分组）。
 * 跳过代码块 / 表格 / 标题。
 */
function humanize(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || /^\s*#/.test(line) || /^\s*\|/.test(line) || line.length <= 60 || !/[。；]/.test(line)) {
      out.push(line)
      continue
    }

    const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/)
    if (listMatch) {
      const [, marker, rest] = listMatch
      const indent = ' '.repeat(marker.length)
      const semis = splitClauses(rest, '；')
      if (semis.length >= 3) {
        // 枚举型列表项：首句留在本项，其余降为子列表
        out.push(marker + stripSemi(semis[0]))
        for (const c of semis.slice(1)) out.push(`${indent}- ${stripSemi(c)}`)
      } else {
        const sents = splitClauses(rest, '。')
        out.push(sents.length >= 2 ? marker + sents.join(`  \n${indent}`) : line)
      }
      continue
    }

    const semis = splitClauses(line, '；')
    if (semis.length >= 3) {
      // 枚举型段落：带"X："引子的留作引语，其余转列表
      const head = stripSemi(semis[0])
      if (/[：:]\s*\S/.test(head) === false && /[：:]$/.test(head.replace(/\*\*/g, ''))) {
        out.push(head)
        for (const c of semis.slice(1)) out.push(`- ${stripSemi(c)}`)
      } else {
        for (const c of semis) out.push(`- ${stripSemi(c)}`)
      }
      continue
    }
    const sents = splitClauses(line, '。')
    out.push(sents.length >= 2 && line.length > 100 ? sents.join('  \n') : line)
  }
  return out.join('\n')
}

export default function DetailDrawer({ node, nodes, links, onClose, onJump, onCreatePlaceholder }: Props) {
  const [entry, setEntry] = useState<EntryDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readable, setReadable] = useState(true)
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // 编辑表单
  const [editBucket, setEditBucket] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editType, setEditType] = useState<MemType>('feedback')
  const [editBody, setEditBody] = useState('')
  // 连线搜索
  const [linkQuery, setLinkQuery] = useState('')
  // 评论
  const [comments, setComments] = useState<LensComment[]>([])
  const [commentQuote, setCommentQuote] = useState('')
  const [commentText, setCommentText] = useState('')

  useEffect(() => {
    setMode('view')
    setNotice(null)
  }, [node.id])

  const loadComments = () => {
    fetchComments(node.slug)
      .then(setComments)
      .catch(() => setComments([]))
  }
  useEffect(loadComments, [node.slug]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 在正文里选中文字 → 作为评论的引文锚点 */
  const captureSelection = () => {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (text && sel && sel.anchorNode && (sel.anchorNode.parentElement?.closest('.entry-body') ?? null)) {
      setCommentQuote(text.slice(0, 500))
    }
  }

  const submitComment = () => {
    if (busy || !commentText.trim() || !entry) return
    setBusy(true)
    postComment({ slug: node.slug, bucket: entry.copies[0].bucket, quote: commentQuote, comment: commentText })
      .then(() => {
        setCommentText('')
        setCommentQuote('')
        setMode('view')
        setNotice('评论已记录——下次 Claude Code 会话会看到并处理')
        loadComments()
      })
      .catch((e) => setNotice(`评论失败：${e.message || e}`))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    if (node.placeholder) return
    let alive = true
    setEntry(null)
    setError(null)
    fetchEntry(node.id)
      .then((e) => alive && setEntry(e))
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [node.id, node.placeholder, node.mtime, refreshKey])

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const backlinks = useMemo(
    () =>
      links
        .filter((l) => l.target === node.id)
        .map((l) => nodeById.get(l.source))
        .filter((n): n is MemNode => !!n),
    [links, node.id, nodeById],
  )
  const outlinks = useMemo(
    () =>
      links
        .filter((l) => l.source === node.id)
        .map((l) => nodeById.get(l.target))
        .filter((n): n is MemNode => !!n),
    [links, node.id, nodeById],
  )

  const shellReason = node.placeholder
    ? '还没写成文件 → 外核'
    : node.readSessions >= SHELL_RULE.kernel
      ? `${node.readSessions} 个会话打开过正文 ≥ ${SHELL_RULE.kernel} → 内核（agent 反复要读的记忆）`
      : node.readSessions >= SHELL_RULE.mid
        ? `${node.readSessions} 个会话打开过正文 → 中核`
        : '没有任何会话打开过正文 → 外核（只有索引行进过上下文）'

  const startEdit = () => {
    if (!entry) return
    setEditBucket(entry.copies[0].bucket)
    setEditTitle(node.title)
    setEditDesc(String(entry.frontmatter.description ?? ''))
    setEditType(node.type === 'unknown' ? 'feedback' : node.type)
    setEditBody(entry.body)
    setMode('edit')
    setNotice(null)
  }

  const submitEdit = () => {
    if (busy) return
    setBusy(true)
    saveEntry({
      slug: node.slug,
      bucket: editBucket,
      title: editTitle.trim() || undefined,
      description: editDesc,
      type: editType,
      body: editBody,
    })
      .then(() => {
        setMode('view')
        setNotice('已保存')
        setRefreshKey((k) => k + 1)
      })
      .catch((e) => setNotice(`保存失败：${e.message || e}`))
      .finally(() => setBusy(false))
  }

  const submitDelete = (bucket: string | 'all') => {
    if (busy) return
    setBusy(true)
    deleteEntry(node.slug, bucket)
      .then(() => onClose())
      .catch((e) => {
        setNotice(`删除失败：${e.message || e}`)
        setBusy(false)
      })
  }

  const submitLink = (to: string) => {
    if (busy) return
    setBusy(true)
    addLink(node.slug, to)
      .then((r) => {
        setNotice(r.added ? `已在正文末尾追加 [[${to}]]` : `正文里已有 [[${to}]]，未重复添加`)
        setMode('view')
        setLinkQuery('')
        setRefreshKey((k) => k + 1)
      })
      .catch((e) => setNotice(`添加失败：${e.message || e}`))
      .finally(() => setBusy(false))
  }

  const linkCandidates = useMemo(() => {
    if (mode !== 'link') return []
    const q = linkQuery.trim().toLowerCase()
    const linked = new Set(outlinks.map((n) => n.id))
    return nodes
      .filter(
        (n) =>
          !n.placeholder &&
          n.id !== node.id &&
          !linked.has(n.id) &&
          (!q || n.title.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q)),
      )
      .slice(0, 10)
  }, [mode, linkQuery, nodes, node.id, outlinks])

  const body = entry ? preprocessWikilinks(readable ? humanize(entry.body) : entry.body) : ''
  const suggestedBucket = backlinks[0]?.bucket

  return (
    <div className="drawer" role="dialog" aria-label={node.title}>
      <div className="drawer-head">
        <div className="drawer-badges">
          <span className="badge type-badge" style={{ color: TYPE_COLOR[node.type], borderColor: TYPE_COLOR[node.type] }}>
            {TYPE_LABEL[node.type]}
          </span>
          <span className="badge" title={shellReason}>
            {SHELL_LABEL[node.shell]}
          </span>
          {node.buckets.map((b) => (
            <span key={b} className="badge bucket-badge">
              {shortBucket(b) || '(根)'}
            </span>
          ))}
        </div>
        <button className="drawer-close" onClick={onClose} aria-label="关闭详情">
          ✕
        </button>
      </div>

      <h2 className="drawer-title">{node.title}</h2>
      {node.description && mode !== 'edit' && <p className="drawer-desc">{node.description}</p>}

      {mode !== 'edit' && (
        <>
          <dl className="meta-grid">
            <div>
              <dt>被读会话</dt>
              <dd>{node.placeholder ? '—' : node.readSessions}</dd>
            </div>
            <div>
              <dt>最后被读</dt>
              <dd>{node.placeholder ? '—' : node.lastRead ? timeAgo(node.lastRead) : '从未'}</dd>
            </div>
            <div>
              <dt>被引 / 引出</dt>
              <dd>
                {node.inDegree} / {node.outDegree}
              </dd>
            </div>
            <div>
              <dt>最后修改</dt>
              <dd>{timeAgo(node.mtime)}</dd>
            </div>
          </dl>
          <p className="shell-reason">分层依据：{shellReason}</p>
        </>
      )}

      {!node.placeholder && mode === 'view' && (
        <div className="action-bar">
          <button className="btn ghost" onClick={startEdit} disabled={!entry}>
            编辑
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              captureSelection()
              setMode('comment')
              setNotice(null)
            }}
            disabled={!entry}
            title="选中正文文字后点击，可带引文评论"
          >
            评论
          </button>
          <button className="btn ghost" onClick={() => setMode('link')}>
            添加关联
          </button>
          <button className="btn danger-ghost" onClick={() => setMode('delete')}>
            删除
          </button>
        </div>
      )}

      {notice && <p className="drawer-notice">{notice}</p>}

      {mode === 'comment' && (
        <div className="inline-panel">
          <p className="panel-hint">
            评论会记录到桶内待办，下次 Claude Code 会话读取并按评论修改这条记忆，改完自动标记已处理。
          </p>
          {commentQuote ? (
            <blockquote className="comment-quote">
              「{commentQuote.length > 120 ? commentQuote.slice(0, 120) + '…' : commentQuote}」
              <button className="quote-clear" onClick={() => setCommentQuote('')} aria-label="去掉引文">
                ✕
              </button>
            </blockquote>
          ) : (
            <p className="panel-hint dim">没有选中引文——评论将针对整条记忆。要精确到某段：先在正文选中文字再点「评论」。</p>
          )}
          <textarea
            autoFocus
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="想怎么改？例如：这段已过时，工具已升级到 v2，请更新并注明日期"
            rows={3}
          />
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setMode('view')} disabled={busy}>
              取消
            </button>
            <button className="btn primary" onClick={submitComment} disabled={busy || !commentText.trim()}>
              {busy ? '记录中…' : '留下评论'}
            </button>
          </div>
        </div>
      )}

      {mode === 'link' && (
        <div className="inline-panel">
          <p className="panel-hint">选一条记忆，在本条正文末尾追加 [[它]]（本条 → 目标 的引用）</p>
          <input
            autoFocus
            value={linkQuery}
            onChange={(e) => setLinkQuery(e.target.value)}
            placeholder="搜索目标记忆…"
          />
          <ul className="pick-list">
            {linkCandidates.map((n) => (
              <li key={n.id}>
                <button className="link-row" onClick={() => submitLink(n.slug)} disabled={busy}>
                  <span className="dot" style={{ background: TYPE_COLOR[n.type] }} />
                  {n.title}
                  <span className="pick-slug">{n.slug}</span>
                </button>
              </li>
            ))}
            {linkCandidates.length === 0 && <li className="pick-empty">没有可选的目标（已链接的不再列出）</li>}
          </ul>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setMode('view')}>
              取消
            </button>
          </div>
        </div>
      )}

      {mode === 'delete' && entry && (
        <div className="inline-panel danger">
          <p className="panel-hint">
            删除会移除文件并同步清掉 MEMORY.md 里的索引行，<strong>不可恢复</strong>。
            {node.inDegree > 0 && ` 注意：还有 ${node.inDegree} 条记忆引用它，删除后它们的链接会悬空。`}
          </p>
          {entry.copies.map((c) => (
            <button key={c.bucket} className="btn danger" onClick={() => submitDelete(c.bucket)} disabled={busy}>
              删除 {shortBucket(c.bucket) || '(根)'} 的副本
            </button>
          ))}
          {entry.copies.length > 1 && (
            <button className="btn danger" onClick={() => submitDelete('all')} disabled={busy}>
              删除全部 {entry.copies.length} 份副本
            </button>
          )}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setMode('view')}>
              取消
            </button>
          </div>
        </div>
      )}

      {mode === 'edit' && entry && (
        <div className="inline-panel">
          {entry.copies.length > 1 && (
            <div className="form-row">
              <label>
                <span>编辑哪份副本</span>
                <select value={editBucket} onChange={(e) => setEditBucket(e.target.value)}>
                  {entry.copies.map((c) => (
                    <option key={c.bucket} value={c.bucket}>
                      {shortBucket(c.bucket)}（{timeAgo(c.mtime)}）
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="form-row two">
            <label>
              <span>标题（同步索引行）</span>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </label>
            <label>
              <span>类型</span>
              <select value={editType} onChange={(e) => setEditType(e.target.value as MemType)}>
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
              <span>描述</span>
              <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
            </label>
          </div>
          <div className="form-row">
            <label>
              <span>正文</span>
              <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={16} spellCheck={false} />
            </label>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setMode('view')} disabled={busy}>
              取消
            </button>
            <button className="btn primary" onClick={submitEdit} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {node.placeholder ? (
        <div className="placeholder-note">
          这是一个悬空链接——有 {backlinks.length} 条记忆引用了 <code>[[{node.slug}]]</code>
          ，但对应文件还没写。
          <button className="btn primary block" onClick={() => onCreatePlaceholder(node.slug, suggestedBucket)}>
            把它写出来
          </button>
        </div>
      ) : error ? (
        <div className="placeholder-note">读取失败：{error}</div>
      ) : entry && mode === 'view' ? (
        <>
          {entry.copies.length > 1 && (
            <p className="dup-note">
              此条目在 {entry.copies.length} 个桶各有一份，正文显示最新副本（
              {shortBucket(entry.copies[0].bucket)}，{timeAgo(entry.copies[0].mtime)}）
            </p>
          )}
          <div className="body-head">
            <h3>正文</h3>
            <div className="segmented small" role="radiogroup" aria-label="正文排版">
              <button
                role="radio"
                aria-checked={readable}
                className={readable ? 'seg-btn active' : 'seg-btn'}
                onClick={() => setReadable(true)}
              >
                易读
              </button>
              <button
                role="radio"
                aria-checked={!readable}
                className={!readable ? 'seg-btn active' : 'seg-btn'}
                onClick={() => setReadable(false)}
              >
                原文
              </button>
            </div>
          </div>
          <article className={readable ? 'entry-body readable' : 'entry-body'}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  if (href?.startsWith('mem:')) {
                    const slug = decodeURIComponent(href.slice(4))
                    const target = nodeById.get(slug)
                    return (
                      <a
                        className={target && !target.placeholder ? 'wikilink' : 'wikilink dangling'}
                        onClick={(e) => {
                          e.preventDefault()
                          if (target) onJump(target.id)
                        }}
                      >
                        {children}
                      </a>
                    )
                  }
                  return (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  )
                },
              }}
            >
              {body}
            </ReactMarkdown>
          </article>
        </>
      ) : !entry && !node.placeholder && mode === 'view' ? (
        <div className="entry-loading">读取原文…</div>
      ) : null}

      {mode === 'view' && comments.length > 0 && (
        <div className="comment-section">
          <h3>评论 · {comments.filter((c) => c.status === 'pending').length} 待处理</h3>
          <ul>
            {comments.map((c) => (
              <li key={c.id} className={c.status === 'done' ? 'comment done' : 'comment'}>
                {c.quote && <blockquote className="comment-quote small">「{c.quote.length > 90 ? c.quote.slice(0, 90) + '…' : c.quote}」</blockquote>}
                <p className="comment-body">{c.comment}</p>
                <div className="comment-meta">
                  <span className={c.status === 'done' ? 'status-chip done' : 'status-chip'}>
                    {c.status === 'done' ? '已处理' : '待 CC 处理'}
                  </span>
                  <span>{timeAgo(c.createdAt)}</span>
                  {c.status === 'pending' && (
                    <button
                      className="comment-act"
                      onClick={() => patchComment(c.bucket, c.id, 'done').then(loadComments)}
                    >
                      标记已处理
                    </button>
                  )}
                  <button className="comment-act" onClick={() => removeComment(c.bucket, c.id).then(loadComments)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {mode === 'view' && (backlinks.length > 0 || outlinks.length > 0) && (
        <div className="link-sections">
          {backlinks.length > 0 && (
            <section>
              <h3>被谁引用 · {backlinks.length}</h3>
              <ul>
                {backlinks.map((n) => (
                  <li key={n.id}>
                    <button className="link-row" onClick={() => onJump(n.id)}>
                      <span className="dot" style={{ background: TYPE_COLOR[n.type] }} />
                      {n.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {outlinks.length > 0 && (
            <section>
              <h3>引用了谁 · {outlinks.length}</h3>
              <ul>
                {outlinks.map((n) => (
                  <li key={n.id}>
                    <button className="link-row" onClick={() => onJump(n.id)}>
                      <span className="dot" style={{ background: n.placeholder ? '#525A6E' : TYPE_COLOR[n.type] }} />
                      {n.title}
                      {n.placeholder && <span className="ghost-tag">未写</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {!node.placeholder && entry && mode === 'view' && (
        <p className="drawer-path">{entry.path.replace(/^\/Users\/[^/]+/, '~')}</p>
      )}
    </div>
  )
}
