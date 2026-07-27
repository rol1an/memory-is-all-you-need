import { SHELL_RULE, type BucketInfo, type GraphStats, type MemType, type Shell } from '../../shared/types'
import { SHELL_LABEL, TYPE_COLOR, TYPE_LABEL } from '../lib/palette'
import type { LensFilter } from '../App'
import type { ColorMode, LinkMode } from './GraphCanvas'

const TYPES: MemType[] = ['feedback', 'user', 'project', 'reference', 'unknown']
const SHELLS: Shell[] = [0, 1, 2]
const SHELL_RULE_TEXT = [
  `≥ ${SHELL_RULE.kernel} 会话读过`,
  `读过 ${SHELL_RULE.mid}–${SHELL_RULE.kernel - 1} 次`,
  '从未被读',
]
const MODES: { key: ColorMode; label: string }[] = [
  { key: 'freshness', label: '读取热度' },
  { key: 'mtime', label: '上次修改' },
  { key: 'community', label: '社区' },
]
const LINK_MODES: { key: LinkMode; label: string }[] = [
  { key: 'always', label: '常显' },
  { key: 'focus', label: '悬停' },
  { key: 'hidden', label: '隐藏' },
]

interface Props {
  buckets: BucketInfo[]
  stats: GraphStats
  typeCounts: Record<string, number>
  shellCounts: [number, number, number]
  activeBuckets: Set<string>
  activeTypes: Set<MemType>
  activeShells: Set<Shell>
  lens: LensFilter
  colorMode: ColorMode
  linkMode: LinkMode
  onToggleBucket: (id: string) => void
  onToggleType: (t: MemType) => void
  onToggleShell: (s: Shell) => void
  onLens: (l: Exclude<LensFilter, null>) => void
  onColorMode: (m: ColorMode) => void
  onLinkMode: (m: LinkMode) => void
}

export default function Sidebar(p: Props) {
  return (
    <aside className="sidebar">
      <section className="side-section">
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-num">{p.stats.merged}</span>
            <span className="stat-label">记忆{p.stats.files > p.stats.merged ? `（${p.stats.files} 份文件）` : ''}</span>
          </div>
          <div className="stat">
            <span className="stat-num">{p.stats.links}</span>
            <span className="stat-label">互链</span>
          </div>
          <button
            className={p.lens === 'orphans' ? 'stat clickable active' : 'stat clickable'}
            onClick={() => p.onLens('orphans')}
            title="只看没有任何互链的记忆"
          >
            <span className="stat-num">{p.stats.orphans}</span>
            <span className="stat-label">孤儿 ⌖</span>
          </button>
          <button
            className={p.lens === 'dangling' ? 'stat clickable active' : 'stat clickable'}
            onClick={() => p.onLens('dangling')}
            title="只看被引用但还没写的条目"
          >
            <span className="stat-num">{p.stats.placeholders}</span>
            <span className="stat-label">悬空 ⌖</span>
          </button>
        </div>
        {p.lens && (
          <p className="lens-note">
            {p.lens === 'orphans' ? '正在只看孤儿记忆——再点一次恢复全图' : '正在只看悬空链接及其引用方——再点一次恢复全图'}
          </p>
        )}
      </section>

      <section className="side-section">
        <h3 className="side-title">分层 · 按 agent 实际读取</h3>
        <ul className="legend">
          {SHELLS.map((s) => {
            const active = p.activeShells.has(s)
            return (
              <li key={s}>
                <button
                  className={active ? 'legend-item' : 'legend-item off'}
                  onClick={() => p.onToggleShell(s)}
                  aria-pressed={active}
                >
                  <span className={`ring-mark ring-${s}`} />
                  <span className="legend-name">
                    {SHELL_LABEL[s]}
                    <span className="legend-rule">{SHELL_RULE_TEXT[s]}</span>
                  </span>
                  <span className="legend-count">{p.shellCounts[s]}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="side-section">
        <h3 className="side-title">着色</h3>
        <div className="segmented" role="radiogroup" aria-label="节点着色方式">
          {MODES.map((m) => (
            <button
              key={m.key}
              role="radio"
              aria-checked={p.colorMode === m.key}
              className={p.colorMode === m.key ? 'seg-btn active' : 'seg-btn'}
              onClick={() => p.onColorMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {p.colorMode !== 'community' && (
          <div className="fresh-legend">
            <span className={p.colorMode === 'mtime' ? 'fresh-bar mtime' : 'fresh-bar'} />
            <div className="fresh-ends">
              {p.colorMode === 'freshness' ? (
                <>
                  <span>最热（亮）</span>
                  <span>最冷 / 从未（暗）</span>
                </>
              ) : (
                <>
                  <span>刚改过（亮）</span>
                  <span>久未改（暗）</span>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="side-section">
        <h3 className="side-title">连线</h3>
        <div className="segmented" role="radiogroup" aria-label="连线显示方式">
          {LINK_MODES.map((m) => (
            <button
              key={m.key}
              role="radio"
              aria-checked={p.linkMode === m.key}
              className={p.linkMode === m.key ? 'seg-btn active' : 'seg-btn'}
              onClick={() => p.onLinkMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </section>

      <section className="side-section">
        <h3 className="side-title">类型</h3>
        <ul className="legend">
          {TYPES.map((t) => {
            const count = p.typeCounts[t] ?? 0
            if (count === 0 && t === 'unknown') return null
            const active = p.activeTypes.has(t)
            return (
              <li key={t}>
                <button
                  className={active ? 'legend-item' : 'legend-item off'}
                  onClick={() => p.onToggleType(t)}
                  aria-pressed={active}
                >
                  <span className="dot" style={{ background: TYPE_COLOR[t] }} />
                  <span className="legend-name">{TYPE_LABEL[t]}</span>
                  <span className="legend-count">{count}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="side-section">
        <h3 className="side-title">记忆桶</h3>
        <ul className="legend">
          {p.buckets.map((b) => {
            const active = p.activeBuckets.has(b.id)
            return (
              <li key={b.id}>
                <button
                  className={active ? 'legend-item' : 'legend-item off'}
                  onClick={() => p.onToggleBucket(b.id)}
                  aria-pressed={active}
                  title={b.dir}
                >
                  <span className="bucket-mark" />
                  <span className="legend-name">{b.label || '(根)'}</span>
                  <span className="legend-count">{b.count}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <footer className="side-footer">
        轨道分层来自 transcript 里的真实 Read 事件；跨桶同名条目已合并；全部指标为确定性计算，无模型参与
      </footer>
    </aside>
  )
}
