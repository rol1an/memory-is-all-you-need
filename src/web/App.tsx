import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GraphPayload, InboxItem, MemType, Shell } from '../shared/types'
import { setBucketPrefix } from '../shared/bucket'
import { fetchGraph, fetchInbox, patchInbox, subscribe } from './lib/api'
import { t } from './lib/i18n'
import GraphCanvas, { type ColorMode, type LinkMode } from './components/GraphCanvas'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import DetailDrawer from './components/DetailDrawer'
import InboxPanel from './components/InboxPanel'
import NewEntryModal, { type NewEntryPrefill } from './components/NewEntryModal'

const ALL_TYPES: MemType[] = ['user', 'feedback', 'project', 'reference', 'unknown']
const ALL_SHELLS: Shell[] = [0, 1, 2]

/** 透镜：从统计卡点出来的一键聚焦视角 */
export type LensFilter = 'orphans' | 'dangling' | null

export default function App() {
  const [payload, setPayload] = useState<GraphPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [showcase, setShowcase] = useState(true)

  const [activeBuckets, setActiveBuckets] = useState<Set<string>>(new Set())
  const [activeTypes, setActiveTypes] = useState<Set<MemType>>(new Set(ALL_TYPES))
  const [activeShells, setActiveShells] = useState<Set<Shell>>(new Set(ALL_SHELLS))
  const [lens, setLens] = useState<LensFilter>(null)
  const [colorMode, setColorMode] = useState<ColorMode>('freshness')
  const [linkMode, setLinkMode] = useState<LinkMode>('always')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | null>(null)
  const [newEntry, setNewEntry] = useState<NewEntryPrefill | null>(null)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [inboxOpen, setInboxOpen] = useState(false)

  const loadInbox = useCallback(() => {
    fetchInbox()
      .then(setInbox)
      .catch(() => setInbox([]))
  }, [])

  const load = useCallback(() => {
    fetchGraph()
      .then((p) => {
        setBucketPrefix(p.homePrefix ?? '')
        setPayload(p)
        setLoadError(null)
        // 首次加载默认全选所有桶；之后保留用户选择、只补新桶
        setActiveBuckets((prev) => (prev.size === 0 ? new Set(p.buckets.map((b) => b.id)) : prev))
      })
      .catch((e) => setLoadError(String(e)))
  }, [])

  useEffect(() => {
    load()
    loadInbox()
    return subscribe(() => {
      load()
      loadInbox()
    }, setLive)
  }, [load, loadInbox])

  // 选中的节点被删掉后自动关抽屉
  useEffect(() => {
    if (payload && selectedId && !payload.nodes.some((n) => n.id === selectedId)) {
      setSelectedId(null)
    }
  }, [payload, selectedId])

  const { visibleNodes, visibleLinks, typeCounts, shellCounts } = useMemo(() => {
    const empty = {
      visibleNodes: [],
      visibleLinks: [],
      typeCounts: {} as Record<string, number>,
      shellCounts: [0, 0, 0] as [number, number, number],
    }
    if (!payload) return empty

    const typeCounts: Record<string, number> = {}
    const shellCounts: [number, number, number] = [0, 0, 0]
    for (const n of payload.nodes) {
      if (n.placeholder) continue
      typeCounts[n.type] = (typeCounts[n.type] ?? 0) + 1
      shellCounts[n.shell]++
    }

    const baseVisible = (n: (typeof payload.nodes)[number]) => {
      if (n.placeholder) return true // 占位节点是否显示由透镜和引用方决定
      if (!n.buckets.some((b) => activeBuckets.has(b))) return false
      if (!activeTypes.has(n.type)) return false
      if (!activeShells.has(n.shell)) return false
      return true
    }

    let nodes = payload.nodes.filter(baseVisible)

    if (lens === 'orphans') {
      nodes = nodes.filter((n) => !n.placeholder && n.inDegree === 0 && n.outDegree === 0)
      return { visibleNodes: nodes, visibleLinks: [], typeCounts, shellCounts }
    }

    if (lens === 'dangling') {
      const placeholderIds = new Set(payload.nodes.filter((n) => n.placeholder).map((n) => n.id))
      const citing = new Set<string>()
      const links = payload.links.filter((l) => {
        if (!l.dangling || !placeholderIds.has(l.target)) return false
        citing.add(l.source)
        return true
      })
      nodes = payload.nodes.filter((n) => placeholderIds.has(n.id) || citing.has(n.id))
      return { visibleNodes: nodes, visibleLinks: links, typeCounts, shellCounts }
    }

    const keep = new Set(nodes.map((n) => n.id))
    const links = payload.links.filter((l) => keep.has(l.source) && keep.has(l.target))
    // 占位节点只有在其引用方可见时才显示
    const linkedPlaceholders = new Set(links.filter((l) => l.dangling).map((l) => l.target))
    nodes = nodes.filter((n) => !n.placeholder || linkedPlaceholders.has(n.id))
    return { visibleNodes: nodes, visibleLinks: links, typeCounts, shellCounts }
  }, [payload, activeBuckets, activeTypes, activeShells, lens])

  const selectedNode = useMemo(
    () => (selectedId ? payload?.nodes.find((n) => n.id === selectedId) ?? null : null),
    [payload, selectedId],
  )

  const focusNode = useCallback((id: string) => {
    setSelectedId(id)
    setFocusRequest({ id, token: Date.now() })
  }, [])

  const toggleIn = <T,>(set: Set<T>, v: T): Set<T> => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    return next
  }

  if (loadError) {
    return (
      <div className="boot-error">
        <h1>{t('连不上解析服务', 'Cannot reach the parsing server')}</h1>
        <p>
          {t('前端在，但 ', 'The frontend is up, but the ')}
          <code>/api/graph</code>
          {t(` 请求失败（${loadError}）。确认 `, ` request failed (${loadError}). Make sure `)}
          <code>npm run dev</code>
          {t(' 同时起了 server 与 web 两个进程。', ' started both the server and the web process.')}
        </p>
      </div>
    )
  }

  return (
    <div className={showcase ? 'app showcase' : 'app'}>
      <TopBar
        nodes={payload?.nodes ?? []}
        live={live}
        inboxPending={inbox.filter((i) => i.status === 'pending').length}
        onFocus={focusNode}
        onNewEntry={() => setNewEntry({})}
        onInbox={() => {
          setSelectedId(null)
          setInboxOpen((v) => !v)
        }}
        onShowcase={() => {
          setSelectedId(null)
          setInboxOpen(false)
          setShowcase(true)
        }}
      />
      <div className="main">
        {payload && (
          <Sidebar
            buckets={payload.buckets}
            stats={payload.stats}
            typeCounts={typeCounts}
            shellCounts={shellCounts}
            activeBuckets={activeBuckets}
            activeTypes={activeTypes}
            activeShells={activeShells}
            lens={lens}
            colorMode={colorMode}
            linkMode={linkMode}
            onToggleBucket={(id) => setActiveBuckets((s) => toggleIn(s, id))}
            onToggleType={(t) => setActiveTypes((s) => toggleIn(s, t))}
            onToggleShell={(sh) => setActiveShells((s) => toggleIn(s, sh))}
            onLens={(l) => setLens((prev) => (prev === l ? null : l))}
            onColorMode={setColorMode}
            onLinkMode={setLinkMode}
          />
        )}
        <GraphCanvas
          nodes={visibleNodes}
          links={visibleLinks}
          colorMode={colorMode}
          linkMode={linkMode}
          showcase={showcase}
          selectedId={selectedId}
          focusRequest={focusRequest}
          onSelect={setSelectedId}
        />
        {showcase && (
          <button className="showcase-veil" onClick={() => setShowcase(false)} aria-label={t('进入操纵界面', 'Enter the observatory')}>
            <span className="veil-hint">
              <span className="veil-title">{t('记忆星系', 'Memory galaxy')}</span>
              <span className="veil-sub">
                {payload
                  ? t(`${payload.stats.merged} 条记忆环绕运行中 · 点击任意处进入`, `${payload.stats.merged} memories in orbit · click anywhere to enter`)
                  : t('加载中…', 'Loading…')}
              </span>
            </span>
          </button>
        )}
        {!showcase && inboxOpen && (
          <InboxPanel
            items={inbox}
            onClose={() => setInboxOpen(false)}
            onStatus={(item, status) => {
              patchInbox(item.bucket, item.id, status).then(loadInbox)
            }}
          />
        )}
        {!showcase && !inboxOpen && selectedNode && payload && (
          <DetailDrawer
            node={selectedNode}
            nodes={payload.nodes}
            links={payload.links}
            onClose={() => setSelectedId(null)}
            onJump={focusNode}
            onCreatePlaceholder={(slug, bucket) => setNewEntry({ slug, bucket })}
          />
        )}
      </div>
      {newEntry && payload && (
        <NewEntryModal
          buckets={payload.buckets}
          prefill={newEntry}
          onClose={() => setNewEntry(null)}
          onCreated={(slug) => {
            setNewEntry(null)
            focusNode(slug)
          }}
        />
      )}
    </div>
  )
}
