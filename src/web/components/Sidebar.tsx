import { SHELL_RULE, type BucketInfo, type GraphStats, type MemType, type Shell } from '../../shared/types'
import { t } from '../lib/i18n'
import { SHELL_LABEL, TYPE_COLOR, TYPE_LABEL } from '../lib/palette'
import type { LensFilter } from '../App'
import type { ColorMode, LinkMode } from './GraphCanvas'

const TYPES: MemType[] = ['feedback', 'user', 'project', 'reference', 'unknown']
const SHELLS: Shell[] = [0, 1, 2]
const SHELL_RULE_TEXT = [
  t(`≥ ${SHELL_RULE.kernel} 会话读过`, `read in ≥ ${SHELL_RULE.kernel} sessions`),
  t(`读过 ${SHELL_RULE.mid}–${SHELL_RULE.kernel - 1} 次`, `read ${SHELL_RULE.mid}–${SHELL_RULE.kernel - 1} times`),
  t('从未被读', 'never read'),
]
const MODES: { key: ColorMode; label: string }[] = [
  { key: 'freshness', label: t('读取热度', 'Read heat') },
  { key: 'mtime', label: t('上次修改', 'Last edited') },
  { key: 'community', label: t('星座', 'Constellations') },
]
const LINK_MODES: { key: LinkMode; label: string }[] = [
  { key: 'always', label: t('常显', 'Always') },
  { key: 'focus', label: t('悬停', 'Hover') },
  { key: 'hidden', label: t('隐藏', 'Hidden') },
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
            <span className="stat-label">
              {t('记忆', 'memories')}
              {p.stats.files > p.stats.merged ? t(`（${p.stats.files} 份文件）`, ` (${p.stats.files} files)`) : ''}
            </span>
          </div>
          <div className="stat">
            <span className="stat-num">{p.stats.links}</span>
            <span className="stat-label">{t('互链', 'links')}</span>
          </div>
          <button
            className={p.lens === 'orphans' ? 'stat clickable active' : 'stat clickable'}
            onClick={() => p.onLens('orphans')}
            title={t('只看没有任何互链的记忆', 'Show only memories with no links at all')}
          >
            <span className="stat-num">{p.stats.orphans}</span>
            <span className="stat-label">{t('孤儿', 'orphans')} ⌖</span>
          </button>
          <button
            className={p.lens === 'dangling' ? 'stat clickable active' : 'stat clickable'}
            onClick={() => p.onLens('dangling')}
            title={t('只看被引用但还没写的条目', 'Show only entries that are referenced but not written yet')}
          >
            <span className="stat-num">{p.stats.placeholders}</span>
            <span className="stat-label">{t('悬空', 'dangling')} ⌖</span>
          </button>
        </div>
        {p.lens && (
          <p className="lens-note">
            {p.lens === 'orphans'
              ? t('正在只看孤儿记忆——再点一次恢复全图', 'Showing orphans only — click again to restore')
              : t('正在只看悬空链接及其引用方——再点一次恢复全图', 'Showing dangling links and their citers — click again to restore')}
          </p>
        )}
      </section>

      <section className="side-section">
        <h3 className="side-title">{t('分层 · 按 agent 实际读取', 'Orbits · by real agent reads')}</h3>
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
        <h3 className="side-title">{t('着色', 'Coloring')}</h3>
        <div className="segmented" role="radiogroup" aria-label={t('节点着色方式', 'Node coloring mode')}>
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
        {p.colorMode === 'community' && (
          <p className="lens-note">
            {t(
              '星座 = 互链自然聚成的社区。悬停星座名点亮它的星与连线；左上角可切换十二星座 / 二十八宿命名',
              'Constellations = link communities. Hover a name to light up its stars and lines; toggle zodiac / 28-mansion naming at top-left',
            )}
          </p>
        )}
        {p.colorMode !== 'community' && (
          <div className="fresh-legend">
            <span className={p.colorMode === 'mtime' ? 'fresh-bar mtime' : 'fresh-bar'} />
            <div className="fresh-ends">
              {p.colorMode === 'freshness' ? (
                <>
                  <span>{t('最热（亮）', 'hottest (bright)')}</span>
                  <span>{t('最冷 / 从未（暗）', 'coldest / never (dark)')}</span>
                </>
              ) : (
                <>
                  <span>{t('刚改过（亮）', 'just edited (bright)')}</span>
                  <span>{t('久未改（暗）', 'stale (dark)')}</span>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="side-section">
        <h3 className="side-title">{t('连线', 'Edges')}</h3>
        <div className="segmented" role="radiogroup" aria-label={t('连线显示方式', 'Edge display mode')}>
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
        <h3 className="side-title">{t('类型', 'Type')}</h3>
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
        <h3 className="side-title">{t('记忆桶', 'Buckets')}</h3>
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
                  <span className="legend-name">{b.label || t('(根)', '(root)')}</span>
                  <span className="legend-count">{b.count}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <footer className="side-footer">
        {t(
          '轨道分层来自 transcript 里的真实 Read 事件；跨桶同名条目已合并；全部指标为确定性计算，无模型参与',
          'Orbits come from real Read events in session transcripts; same-slug copies across buckets are merged; every metric is deterministic — no model involved',
        )}
      </footer>
    </aside>
  )
}
