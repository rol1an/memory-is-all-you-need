import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { execFileSync } from 'node:child_process'
import { WebSocketServer } from 'ws'
import chokidar from 'chokidar'
import { buildGraph, listMemoryDirs, readEntry, PROJECTS_ROOT } from './scan.js'
import { MutateError, addLink, createEntry, deleteEntry, saveEntry } from './mutate.js'
import { addComment, deleteComment, listComments, setCommentStatus } from './comments.js'
import { deleteInboxItem, listInbox, setInboxStatus } from './inbox.js'
import { anonymizeEntry, anonymizeGraph } from './anonymize.js'
import { demoEntry, loadDemoGraphs, pickDemoLang, type DemoGraphs } from './demo.js'
import { startCardListener } from './card-listener.js'
import { censusTranscripts, refreshReadStats, type ReadStats } from './readstats.js'
import type { GraphPayload } from '../shared/types.js'

const PORT = Number(process.env.PORT || 5611)
const READSTATS_REFRESH_MS = 120_000

// 演示模式：不扫描本机文件，供给打包好的样例图谱（真结构、假文字），按 Accept-Language 分中英
const DEMO = process.env.LENS_DEMO === '1'
const demoGraphs: DemoGraphs | null = DEMO ? loadDemoGraphs() : null

// 启动先挖一遍 transcript 读取事实（增量缓存，后续刷新只重读变过的会话文件）
const t0 = Date.now()
let readStats: ReadStats = DEMO ? new Map() : await refreshReadStats()
let graph: GraphPayload = demoGraphs
  ? demoGraphs.zh
  : buildGraph(PROJECTS_ROOT, readStats, censusTranscripts(readStats))
if (DEMO) {
  console.log(`[claude-lens] demo mode: ${graph.stats.merged} sample memories / ${graph.stats.links} links (nothing on this machine is read)`)
} else {
  console.log(
    `[claude-lens] scanned ${graph.stats.files} entries / ${graph.stats.links} links across ${graph.buckets.length} buckets; ` +
      `read-stats: ${readStats.size} files ever read (mined in ${Date.now() - t0}ms) (${PROJECTS_ROOT})`,
  )
  if (graph.stats.files === 0) {
    console.log('[claude-lens] no memory entries found — try `npx memory-is-all-you-need --demo` to see a sample galaxy')
  }
}

const app = new Hono()

// 匿名截图模式：结构全真、文字全假，对着真实数据截演示图/录屏不泄内容。
// 演示/匿名都强制只读——防止误触编辑把占位文案写回真实记忆文件
const ANONYMIZE = process.env.LENS_ANONYMIZE === '1'
const READONLY = ANONYMIZE || DEMO
if (READONLY) {
  app.use('*', async (c, next) => {
    const mutating = c.req.method !== 'GET' || c.req.path === '/inbox/act'
    if (mutating && c.req.path.startsWith('/api')) return c.json({ error: 'read-only mode (demo/anonymize) · 只读模式' }, 403)
    if (mutating && c.req.path === '/inbox/act') return c.html('<meta charset="utf-8">read-only mode · 只读模式', 403)
    await next()
  })
}
app.get('/api/graph', (c) => {
  if (demoGraphs) return c.json(demoGraphs[pickDemoLang(c.req.header('accept-language'))])
  return c.json(ANONYMIZE ? anonymizeGraph(graph) : graph)
})

app.get('/api/entry', (c) => {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)
  if (demoGraphs) {
    const lang = pickDemoLang(c.req.header('accept-language'))
    const node = demoGraphs[lang].nodes.find((n) => n.id === id && !n.placeholder)
    if (!node) return c.json({ error: 'not found' }, 404)
    return c.json(demoEntry(node, lang))
  }
  const entry = readEntry(PROJECTS_ROOT, id)
  if (!entry) return c.json({ error: 'not found' }, 404)
  return c.json(ANONYMIZE ? anonymizeEntry(entry) : entry)
})

app.onError((err, c) => {
  if (err instanceof MutateError) return c.json({ error: err.message }, err.status as 400)
  console.error('[claude-lens] error:', err)
  return c.json({ error: String(err) }, 500)
})

app.put('/api/entry', async (c) => {
  const body = await c.req.json()
  const result = saveEntry(PROJECTS_ROOT, body)
  rebuildAndBroadcast('edit', result.path)
  return c.json(result)
})

app.delete('/api/entry', async (c) => {
  const slug = c.req.query('id')
  const bucket = c.req.query('bucket') || 'all'
  if (!slug) return c.json({ error: 'missing id' }, 400)
  const result = deleteEntry(PROJECTS_ROOT, slug, bucket)
  rebuildAndBroadcast('delete', result.deleted.join(','))
  return c.json(result)
})

app.post('/api/entry', async (c) => {
  const body = await c.req.json()
  const result = createEntry(PROJECTS_ROOT, body)
  rebuildAndBroadcast('create', result.path)
  return c.json(result)
})

app.post('/api/link', async (c) => {
  const { from, to } = await c.req.json()
  const result = addLink(PROJECTS_ROOT, from, to)
  if (result.added) rebuildAndBroadcast('link', result.path)
  return c.json(result)
})

// ── 记忆评论：人标注意图，CC 下次会话来改 ──
app.get('/api/comments', (c) =>
  c.json(READONLY ? [] : listComments(PROJECTS_ROOT, c.req.query('slug') || undefined)),
)

app.post('/api/comments', async (c) => {
  const body = await c.req.json()
  return c.json(addComment(PROJECTS_ROOT, body))
})

app.patch('/api/comments', async (c) => {
  const { bucket, id, status } = await c.req.json()
  setCommentStatus(PROJECTS_ROOT, bucket, id, status)
  return c.json({ ok: true })
})

app.delete('/api/comments', (c) => {
  const bucket = c.req.query('bucket')
  const id = c.req.query('id')
  if (!bucket || !id) return c.json({ error: 'missing bucket/id' }, 400)
  deleteComment(PROJECTS_ROOT, bucket, id)
  return c.json({ ok: true })
})

// ── 记忆候选收件箱：供给侧管线产出，人审后 CC 写入 ──
app.get('/api/inbox', (c) => c.json(READONLY ? [] : listInbox(PROJECTS_ROOT)))

app.patch('/api/inbox', async (c) => {
  const { bucket, id, status } = await c.req.json()
  setInboxStatus(PROJECTS_ROOT, bucket, id, status)
  return c.json({ ok: true })
})

app.delete('/api/inbox', (c) => {
  const bucket = c.req.query('bucket')
  const id = c.req.query('id')
  if (!bucket || !id) return c.json({ error: 'missing bucket/id' }, 400)
  deleteInboxItem(PROJECTS_ROOT, bucket, id)
  return c.json({ ok: true })
})

// 飞书卡片按钮走的 GET 审核端点（服务只绑 127.0.0.1，仅本机可点）
app.get('/inbox/act', (c) => {
  const bucket = c.req.query('bucket')
  const id = c.req.query('id')
  const action = c.req.query('action')
  if (!bucket || !id || (action !== 'accept' && action !== 'dismiss')) {
    return c.html('<meta charset="utf-8">参数不对', 400)
  }
  setInboxStatus(PROJECTS_ROOT, bucket, id, action === 'accept' ? 'accepted' : 'dismissed')
  const label = action === 'accept' ? '已接受 — 下次 Claude Code 会话会写入记忆' : '已忽略 — 同类内容不再提案'
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Memory Is All You Need</title>
<body style="background:#0e1118;color:#e9e6dc;font-family:'PingFang SC',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:34px">${action === 'accept' ? '✦' : '·'}</div>
<p style="font-size:15px">${label}</p>
<p style="color:#8a90a6;font-size:13px">这个标签页可以关掉了 · <a href="/" style="color:#e5a158">打开观测台</a></p></div></body>`,
  )
})

// 生产形态：同端口托管打好包的前端（dist/），API 路由已在上面注册故不受影响
app.use('/*', serveStatic({ root: './dist' }))
app.use('*', serveStatic({ path: './dist/index.html' }))

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[claude-lens] api on http://localhost:${info.port}`)
})

const wss = new WebSocketServer({ server: server as import('node:http').Server, path: '/ws' })
const broadcast = (msg: unknown) => {
  const data = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data)
  }
}

function rebuildAndBroadcast(event: string, file: string) {
  graph = buildGraph(PROJECTS_ROOT, readStats, censusTranscripts(readStats))
  console.log(`[claude-lens] rebuilt after ${event}: ${file}`)
  broadcast({ type: 'graph', event, file, generatedAt: graph.generatedAt })
}

// 读取事实定期增量刷新：新会话读了记忆 → 轨道自动更新（演示模式无本机数据，跳过）
if (!DEMO) {
  setInterval(async () => {
    try {
      const next = await refreshReadStats()
      const changed =
        next.size !== readStats.size ||
        [...next].some(([k, v]) => {
          const prev = readStats.get(k)
          return !prev || prev.sessions.size !== v.sessions.size || prev.lastRead !== v.lastRead
        })
      readStats = next
      if (changed) rebuildAndBroadcast('read-stats', '(transcripts)')
    } catch (e) {
      console.error('[claude-lens] read-stats refresh failed:', e)
    }
  }, READSTATS_REFRESH_MS)
}

// 飞书卡片按钮回调：点击"记住/不记"改收件箱状态 + 原地更新卡片，并推送前端刷新
// 没装 lark-cli 或显式关闭（LENS_NO_FEISHU=1）时跳过，避免 5 秒重启循环刷错误日志
const hasLarkCli = (() => {
  try {
    execFileSync('which', ['lark-cli'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
if (DEMO || process.env.LENS_NO_FEISHU === '1' || !hasLarkCli) {
  console.log('[lens] card listener disabled (demo mode, lark-cli not found, or LENS_NO_FEISHU=1)')
} else {
  startCardListener(() => broadcast({ type: 'graph', event: 'inbox', file: '(card-action)', generatedAt: Date.now() }))
}

// 记忆目录变化（外部编辑器 / Claude Code 写入）→ 防抖重建 → 推送前端（演示模式跳过）
if (!DEMO) {
  let timer: NodeJS.Timeout | null = null
  const watcher = chokidar.watch(listMemoryDirs(), { ignoreInitial: true, depth: 1 })
  watcher.on('all', (event, file) => {
    if (!file.endsWith('.md')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => rebuildAndBroadcast(event, file), 400)
  })
}
