import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildGraph, HOME_PREFIX, PROJECTS_ROOT } from '../src/server/scan.js'
import { refreshReadStats } from '../src/server/readstats.js'
import { anonymizeGraph, hash } from '../src/server/anonymize.js'
import type { GraphPayload } from '../src/shared/types.js'

/**
 * 从本机真实记忆库导出打包用演示图谱（demo/graph.{zh,en}.json）。
 * 在 anonymizeGraph（标题/描述/桶名脱敏）之上再做两层：
 *   1. id/slug 全部重映射——真实 slug 本身就是内容泄露；
 *   2. 程序化断言：输出里不得出现任何真实 id、标题、描述、桶名、home 前缀。
 * 结构（互链/轨道/读取热度/社区）原样保留——演示的美来自真实结构。
 */

// 与 anonymize.ts 的中文标题池逐条对应的英文池，同下标同素材
const EN_TITLE_POOL = [
  'Build & test command cheatsheet', 'API error envelope convention', 'Three rules for DB migrations', 'Code review self-checklist', 'Use pnpm as package manager',
  'Release train cadence', 'v2 API freeze schedule', 'Quarantine flaky CI tests first', 'Error logs must carry request context', 'No global singleton for config',
  'WS reconnect strategy (final)', 'Design tokens doc entry', 'How E2E seed data is generated', 'Canvas perf budget: 16ms', 'PR title convention',
  'UI glossary', 'Legacy login flow (deprecated)', 'Feature flags to clean up', 'Sentry alert triage habits', 'Onboarding checklist',
  'Brand assets location', '2025 retro takeaways', 'Deploy runbook', 'Roll back first, debug later', 'Postgres slow-query handbook',
  'Resource quotas: measure, don’t guess', 'Key rotation schedule', 'TF module naming rules', 'Backups need restore drills', 'Cloud cost dashboard',
  'On-call handover template', 'Legacy VM inventory', 'Monitoring dashboard index', 'Old nginx tuning notes (archived)', 'Writing style: short sentences, few adjectives',
  'Meeting notes template', 'Reading notes workflow', 'No meetings before noon', 'Blog draft index', 'Talk topic pool',
  'Annual review question list', 'Keyboard shortcut notes', 'Podcast queue', 'Travel packing list', 'Cache-key A/B experiment verdict',
  'Small-sample vector recall test', 'WebGPU canvas rendering trial', 'SQLite WAL load-test data', 'LRU eviction parameter sweep', 'Prompt cache hit ledger',
  'wasm diff algorithm benchmark', 'Idle scheduler prototype notes', 'CRDT selection notes', 'Offline-first trade-offs', 'Image pipeline compression comparison',
  'Flamegraph capture procedure', 'Feature store research archive', 'Benchmark scaffold usage', 'Why we dropped GraphQL (archive)', 'Rate limiter token bucket params',
  'Monorepo split pre-study', 'OTel instrumentation pilot verdict', 'Plan mode first for big changes', 'Write-guard hook rules', 'When subagent fan-out is worth it',
  'MEMORY.md injection cap facts', 'Headless batch run recipe', 'Common MCP servers list', 'Skills vs rules division', 'Where transcripts are stored',
  'What survives a compact', 'Permission mode differences', 'Worktree isolation for parallel sessions', 'Prompt verbs must be concrete', 'Context budget habits',
  'How to build an eval loop', 'Diff review workflow', 'Session naming convention', 'Retry rules for tool errors', 'Commit granularity & co-change',
  'Monitoring long-running tasks', 'Model selection rules of thumb', 'Sync conflict merge strategy', 'Cursor broadcast throttle: 200ms', 'Undo stack cap & memory',
  'PDF export font pitfalls', 'Mobile gesture mapping table', 'Whiteboard permission model (final)', 'Fixing comment anchor drift', 'Thumbnail background job',
  'Storage quota tiers', 'When to rebuild the search index', 'Emoji reaction scope rules', 'Template library ops flow', 'A11y focus ring spec',
  'Paste behavior rules', 'Replay redaction checklist', 'Billing webhook retry semantics', 'Churn dashboard entry', 'Beta council roster location',
  'Perf gate thresholds in CI', 'Icon naming rules', 'Alert routing matrix', 'CDN cache rule notes', 'Connection pool params (final)',
  'Object storage lifecycle policy', 'VPN triage in three steps', 'Base image convention', 'Staging data refresh cadence', 'Domain renewal dates',
  'Load-test handbook entry', 'Incident severity definitions', 'IPv6 rollout notes', 'KMS key usage rules', 'Weekly review ritual',
  'Inbox-zero rules', 'Learning log format', 'Talk rehearsal checklist', 'Book highlights into the KB', 'Desk equipment list',
  'Coffee budget line', 'Family calendar sync setup', 'Side project triage criteria', 'Standing desk reminder setup', 'Gradual rollout cadence table',
  'Top-10 slow endpoints ledger', 'Support ticket attribution rules', 'Data redaction checklist', 'Experiment platform metric definitions', 'Crash rate red line & response',
  'Dependency upgrade windows', 'Third-party quotas & rate limits', 'License compliance notes', 'Capacity planning rough math', 'Failure drill schedule',
  'API deprecation process', 'Analytics event naming rules', 'Offboarding handover template', 'OSS contribution flow', 'Tech radar quarterly notes',
  'Team glossary', 'Tooling account index', 'Recording & screenshot rules', 'Docs folder structure convention', 'Standup three questions template',
]

function remapForLang(anon: GraphPayload, real: GraphPayload, lang: 'zh' | 'en'): GraphPayload {
  // 英文标题沿用 anonymize 的领取顺序（id 哈希排序），保证稳定且不重复（池尽才复用）
  const sorted = [...real.nodes].sort((a, b) => hash(a.id) - hash(b.id))
  const enTitle = new Map<string, string>()
  sorted.forEach((n, i) => enTitle.set(n.id, EN_TITLE_POOL[i % EN_TITLE_POOL.length]))

  const idOf = new Map<string, string>()
  anon.nodes.forEach((n, i) => idOf.set(n.id, `mem-${String(i + 1).padStart(3, '0')}`))

  return {
    ...anon,
    homePrefix: '',
    buckets: anon.buckets.map((b) => ({ ...b, dir: '(demo)' })),
    nodes: anon.nodes.map((n) => ({
      ...n,
      id: idOf.get(n.id)!,
      slug: idOf.get(n.id)!,
      title: lang === 'zh' ? n.title : enTitle.get(n.id) ?? n.title,
      description: '',
    })),
    links: anon.links.map((l) => ({ ...l, source: idOf.get(l.source) ?? l.source, target: idOf.get(l.target) ?? l.target })),
  }
}

/** 泄漏断言：任何真实文字出现在输出里就中止导出 */
function assertNoLeak(json: string, real: GraphPayload) {
  const forbidden = new Set<string>()
  const add = (s: string | undefined, minLen: number) => {
    if (s && s.trim().length >= minLen) forbidden.add(s.trim())
  }
  for (const n of real.nodes) {
    add(n.id, 5)
    add(n.title, 4)
    add(n.description, 6)
  }
  for (const b of real.buckets) {
    add(b.id, 5)
    add(b.dir, 5)
  }
  add(HOME_PREFIX, 5)
  add(os.homedir(), 5)
  add(os.userInfo().username, 4)
  // home 路径的每一段单独设防（用户名/公司名常出现在 /Users/<x> 里）
  for (const seg of os.homedir().split(path.sep)) add(seg, 4)
  const hits = [...forbidden].filter((f) => json.includes(f))
  if (hits.length > 0) {
    throw new Error(`导出被泄漏断言中止，命中 ${hits.length} 条真实文字：\n${hits.slice(0, 20).join('\n')}`)
  }
}

const readStats = await refreshReadStats()
const real = buildGraph(PROJECTS_ROOT, readStats)
const anon = anonymizeGraph(real)

fs.mkdirSync(path.join(import.meta.dirname, '..', 'demo'), { recursive: true })
for (const lang of ['zh', 'en'] as const) {
  const out = remapForLang(anon, real, lang)
  const json = JSON.stringify(out)
  assertNoLeak(json, real)
  const file = path.join(import.meta.dirname, '..', 'demo', `graph.${lang}.json`)
  fs.writeFileSync(file, json)
  console.log(`${file}: ${out.nodes.length} nodes / ${out.links.length} links, ${(json.length / 1024).toFixed(0)}KB — 泄漏断言通过`)
}
