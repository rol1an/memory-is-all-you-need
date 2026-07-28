import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { forceCollide, forceRadial } from 'd3-force'
import type { MemLink, MemNode } from '../../shared/types'
import { t } from '../lib/i18n'
import { MANSION_NAMES, NEVER_READ_COLOR, SHELL_LABEL, SHELL_RADIUS, ZODIAC_NAMES, communityColor, heatColor, mtimeColor, withAlpha } from '../lib/palette'
import { ZODIAC_FIGURES } from '../lib/zodiacFigures'

export type ColorMode = 'freshness' | 'mtime' | 'community'
export type LinkMode = 'always' | 'focus' | 'hidden'

/** 力导向引擎会在节点对象上挂 x/y 等坐标字段 */
type SimNode = MemNode & { x?: number; y?: number }
type SimLink = Omit<MemLink, 'source' | 'target'> & { source: string | SimNode; target: string | SimNode }

interface Props {
  nodes: MemNode[]
  links: MemLink[]
  colorMode: ColorMode
  linkMode: LinkMode
  showcase: boolean
  selectedId: string | null
  focusRequest: { id: string; token: number } | null
  onSelect: (id: string | null) => void
}

const endpointId = (v: string | SimNode) => (typeof v === 'string' ? v : v.id)

/** Cosmograph 式小光点：尺寸差异克制，亮度靠聚集而非单点膨胀 */
const nodeR = (n: SimNode) => (n.placeholder ? 1.8 : 2.2 + 0.9 * Math.sqrt(n.inDegree))

/** 稳定的字符串哈希（漂浮相位/振幅用，避免每次渲染抖动） */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

/** Andrew 单调链凸包：星座轮廓边界用 */
function convexHull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length <= 3) return [...pts]
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: { x: number; y: number }[] = []
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: { x: number; y: number }[] = []
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}


export default function GraphCanvas({
  nodes,
  links,
  colorMode,
  linkMode,
  showcase,
  selectedId,
  focusRequest,
  onSelect,
}: Props) {
  const fgRef = useRef<ForceGraphMethods<SimNode, SimLink>>()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [hoverId, setHoverId] = useState<string | null>(null)
  // 星座命名方案：默认十二星座，可切二十八宿；hoverConst = 指针悬在哪个星座名上
  const [scheme, setScheme] = useState<'zodiac' | 'mansions'>(() =>
    localStorage.getItem('lens-constellation-scheme') === 'mansions' ? 'mansions' : 'zodiac',
  )
  const [hoverConst, setHoverConst] = useState<number | null>(null)
  // 星座名的图坐标包围盒，每帧由 paintPre 重写，鼠标移动时做命中测试
  const labelBoxes = useRef<{ c: number; x0: number; y0: number; x1: number; y1: number }[]>([])
  // 队形编排（十二星座方案）：悬停时成员星飞到图形顶点站位，松开回原位。
  // morphTargets = 目标位；morphReturn = 出发前原位；morphFig = 顶点归属（成员 id 或幽灵点）
  const morphTargets = useRef<Map<string, { x: number; y: number }> | null>(null)
  const morphReturn = useRef(new Map<string, { x: number; y: number }>())
  const morphFig = useRef<{ segs: [number, number][]; owners: (string | null)[]; mapped: { x: number; y: number }[] } | null>(null)
  // 悬停期间星座名锚定在悬停开始时的位置——队形移动不许把名字从指针下面挪走（会造成悬停振荡）
  const hoverAnchor = useRef<{ c: number; x0: number; y0: number; x1: number; y1: number } | null>(null)
  const didFit = useRef(false)
  // 展示模式过渡量 0..1，渲染帧内插值，避免布尔切换的生硬
  const showcaseT = useRef(showcase ? 1 : 0)
  const engineIdle = useRef(false)
  // 漂浮基准位（引擎静止后记录，随正弦轻摆）
  const driftBase = useRef(new Map<string, { bx: number; by: number; p1: number; p2: number; amp: number; sp: number }>())

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 节点对象跨数据刷新复用坐标，避免每次重扫都重新炸开
  const posCache = useRef(new Map<string, { x: number; y: number }>())
  const simNodesRef = useRef<SimNode[]>([])
  const graphData = useMemo(() => {
    const simNodes: SimNode[] = nodes.map((n) => {
      const cached = posCache.current.get(n.id)
      return cached ? { ...n, ...cached } : { ...n }
    })
    const simLinks: SimLink[] = links.map((l) => ({ ...l }))
    simNodesRef.current = simNodes
    return { nodes: simNodes, links: simLinks }
  }, [nodes, links])

  // 邻接表：hover 高亮邻居用
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>()
    const add = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set())
      map.get(a)!.add(b)
    }
    for (const l of links) {
      add(l.source, l.target)
      add(l.target, l.source)
    }
    return map
  }, [links])

  const highlightSet = useMemo(() => {
    const focus = hoverId ?? selectedId
    if (!focus || showcase) return null
    const set = new Set<string>([focus])
    for (const n of neighbors.get(focus) ?? []) set.add(n)
    return set
  }, [hoverId, selectedId, neighbors, showcase])

  // 读取热度排名分位（0=最热 1=最冷）；从未被读单独归档
  const heatRank = useMemo(() => {
    const read = nodes.filter((n) => !n.placeholder && n.lastRead > 0).sort((a, b) => b.lastRead - a.lastRead)
    const map = new Map<string, number>()
    read.forEach((n, i) => map.set(n.id, read.length > 1 ? i / (read.length - 1) : 0))
    return map
  }, [nodes])

  // 上次修改排名分位（0=刚改过 1=最陈旧）；每个文件都有 mtime，无"从未"档
  const mtimeRank = useMemo(() => {
    const all = nodes.filter((n) => !n.placeholder).sort((a, b) => b.mtime - a.mtime)
    const map = new Map<string, number>()
    all.forEach((n, i) => map.set(n.id, all.length > 1 ? i / (all.length - 1) : 0))
    return map
  }, [nodes])

  // 星座：每个互链社区一个星座。骨架线 = 社区内最大生成树（Kruskal，保留最强互链），
  // 像真星图那样用少数结构线勾出形状而不是画满所有边；名字按规模从大到小领取
  const constellations = useMemo(() => {
    const byComm = new Map<number, MemNode[]>()
    for (const n of nodes) {
      if (n.placeholder || n.community < 0) continue
      const list = byComm.get(n.community) ?? []
      list.push(n)
      byComm.set(n.community, list)
    }
    const groups = [...byComm.entries()].filter(([, m]) => m.length >= 3).sort((a, b) => b[1].length - a[1].length)
    return groups.map(([community, members], i) => {
      const ids = new Set(members.map((m) => m.id))
      const parent = new Map<string, string>()
      const find = (x: string): string => {
        const p = parent.get(x) ?? x
        if (p === x) return x
        const r = find(p)
        parent.set(x, r)
        return r
      }
      const tree: [string, string][] = []
      const edges = links
        .filter((l) => ids.has(l.source) && ids.has(l.target) && l.source !== l.target)
        .sort((a, b) => b.weight - a.weight)
      for (const e of edges) {
        const ra = find(e.source)
        const rb = find(e.target)
        if (ra === rb) continue
        parent.set(ra, rb)
        tree.push([e.source, e.target])
      }
      return { community, rank: i, memberIds: [...ids], tree }
    })
  }, [nodes, links])

  const namePool = scheme === 'zodiac' ? ZODIAC_NAMES : MANSION_NAMES

  useEffect(() => {
    if (colorMode !== 'community') setHoverConst(null)
  }, [colorMode])

  // 悬停开始：给成员星分配图形顶点站位。最近者优先领顶点；星不够用幽灵点补形；
  // 多出来的星沿图形连线均匀落位（真星座里也有沿线的暗星）
  useEffect(() => {
    if (colorMode !== 'community' || scheme !== 'zodiac' || hoverConst === null) {
      morphTargets.current = null
      morphFig.current = null
      return
    }
    const c = constellations.find((x) => x.community === hoverConst)
    const figure = c ? ZODIAC_FIGURES[c.rank] : undefined
    if (!c || !figure) {
      morphTargets.current = null
      morphFig.current = null
      return
    }
    const members = simNodesRef.current.filter(
      (n) => !n.placeholder && n.community === hoverConst && n.x !== undefined && n.y !== undefined,
    )
    if (members.length < 3) return
    for (const m of members) {
      if (!morphReturn.current.has(m.id)) morphReturn.current.set(m.id, { x: m.x!, y: m.y! })
    }
    let cx = 0
    let cy = 0
    for (const m of members) {
      cx += m.x!
      cy += m.y!
    }
    cx /= members.length
    cy /= members.length
    // 队形尺寸随成员数微调，落在轨道间距的量级上
    const dim = 90 + 9 * Math.sqrt(members.length)
    let fMinX = Infinity, fMaxX = -Infinity, fMinY = Infinity, fMaxY = -Infinity
    for (const [fx, fy] of figure.pts) {
      fMinX = Math.min(fMinX, fx)
      fMaxX = Math.max(fMaxX, fx)
      fMinY = Math.min(fMinY, fy)
      fMaxY = Math.max(fMaxY, fy)
    }
    const s = dim / Math.max(fMaxX - fMinX, fMaxY - fMinY, 0.01)
    const fCx = (fMinX + fMaxX) / 2
    const fCy = (fMinY + fMaxY) / 2
    const mapped = figure.pts.map(([fx, fy]) => ({ x: cx + (fx - fCx) * s, y: cy + (fy - fCy) * s }))

    const remaining = new Set(members)
    const owners: (string | null)[] = mapped.map((pt) => {
      let best: SimNode | null = null
      let bestD = Infinity
      for (const m of remaining) {
        const d = (m.x! - pt.x) ** 2 + (m.y! - pt.y) ** 2
        if (d < bestD) {
          bestD = d
          best = m
        }
      }
      if (best) remaining.delete(best)
      return best?.id ?? null
    })
    const targets = new Map<string, { x: number; y: number }>()
    owners.forEach((id, i) => id && targets.set(id, mapped[i]))
    ;[...remaining].forEach((m, k) => {
      const [a, b] = figure.segs[k % figure.segs.length]
      const tt = 0.25 + ((k * 29) % 50) / 100
      targets.set(m.id, {
        x: mapped[a].x + (mapped[b].x - mapped[a].x) * tt,
        y: mapped[a].y + (mapped[b].y - mapped[a].y) * tt,
      })
    })
    morphTargets.current = targets
    morphFig.current = { segs: figure.segs as [number, number][], owners, mapped }
  }, [hoverConst, scheme, colorMode, constellations])

  // 同心轨道力：内核/中核/外核各归其环
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.d3Force('charge')?.strength(-60)
    const linkForce = fg.d3Force('link') as { distance?: (d: number) => void } | undefined
    linkForce?.distance?.(48)
    fg.d3Force('radial', forceRadial<SimNode>((n) => SHELL_RADIUS[n.shell ?? 2], 0, 0).strength(0.85))
    // 碰撞力：留出标签呼吸空间，节点不再互相叠压
    fg.d3Force('collide', forceCollide<SimNode>((n) => nodeR(n) + 7).strength(0.9))
  }, [])

  useEffect(() => {
    engineIdle.current = false
    driftBase.current.clear()
    // 数据刷新会重启力引擎，队形编排全部作废（原位由引擎重新决定）
    morphTargets.current = null
    morphFig.current = null
    morphReturn.current.clear()
    setHoverConst(null)
    fgRef.current?.d3ReheatSimulation()
  }, [graphData])

  useEffect(() => {
    if (!showcase) driftBase.current.clear()
  }, [showcase])

  // 搜索定位：飞到目标节点
  useEffect(() => {
    if (!focusRequest) return
    const node = graphData.nodes.find((n) => n.id === focusRequest.id)
    const fg = fgRef.current
    if (!node || !fg || node.x === undefined) return
    fg.centerAt(node.x, node.y, 700)
    fg.zoom(2.6, 700)
  }, [focusRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  const nodeColor = useCallback(
    (n: SimNode) => {
      if (n.placeholder) return '#525A6E'
      if (colorMode === 'community') return communityColor(n.community)
      if (colorMode === 'mtime') return mtimeColor(mtimeRank.get(n.id) ?? 1)
      return n.lastRead > 0 ? heatColor(heatRank.get(n.id) ?? 1) : NEVER_READ_COLOR
    },
    [colorMode, heatRank, mtimeRank],
  )

  /** 帧前：过渡量推进 + 漂浮 + 恒星 + 轨道环 */
  const paintPre = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      const target = showcase ? 1 : 0
      showcaseT.current += (target - showcaseT.current) * 0.055
      const T = showcaseT.current
      const t = performance.now() / 1000

      // 队形编排步进：悬停星座名时成员星飞向图形顶点，松开缓动回原位（只在引擎静止后接管坐标）
      if (engineIdle.current && colorMode === 'community') {
        if (morphTargets.current) {
          for (const n of simNodesRef.current) {
            const tg = morphTargets.current.get(n.id)
            if (!tg || n.x === undefined || n.y === undefined) continue
            n.x += (tg.x - n.x) * 0.13
            n.y += (tg.y - n.y) * 0.13
          }
        } else if (morphReturn.current.size > 0) {
          for (const n of simNodesRef.current) {
            const o = morphReturn.current.get(n.id)
            if (!o || n.x === undefined || n.y === undefined) continue
            n.x += (o.x - n.x) * 0.13
            n.y += (o.y - n.y) * 0.13
            if (Math.hypot(o.x - n.x, o.y - n.y) < 0.5) {
              n.x = o.x
              n.y = o.y
              morphReturn.current.delete(n.id)
            }
          }
        }
      }

      // 漂浮：引擎静止且处于展示模式时，小行星绕基准位轻摆
      if (showcase && engineIdle.current) {
        for (const n of simNodesRef.current) {
          if (n.x === undefined || n.y === undefined) continue
          let d = driftBase.current.get(n.id)
          if (!d) {
            const h1 = hash(n.id)
            const h2 = hash(n.id + '~')
            d = { bx: n.x, by: n.y, p1: h1 * Math.PI * 2, p2: h2 * Math.PI * 2, amp: 2.5 + h1 * 4, sp: 0.18 + h2 * 0.2 }
            driftBase.current.set(n.id, d)
          }
          n.x = d.bx + Math.sin(t * d.sp + d.p1) * d.amp
          n.y = d.by + Math.cos(t * d.sp * 0.85 + d.p2) * d.amp
        }
      }

      // 恒星：中央光源（加法混合成真发光体），展示模式全亮，操纵模式收成余烬
      const intensity = 0.35 + 0.65 * T
      const pulse = 1 + 0.04 * Math.sin(t * 0.6)
      const coreR = 16 * pulse
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 190 * pulse)
      halo.addColorStop(0, `rgba(255,220,160,${0.4 * intensity})`)
      halo.addColorStop(0.18, `rgba(255,190,110,${0.18 * intensity})`)
      halo.addColorStop(0.45, `rgba(210,150,90,${0.06 * intensity})`)
      halo.addColorStop(1, 'rgba(210,150,90,0)')
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(0, 0, 190 * pulse, 0, 2 * Math.PI)
      ctx.fill()
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR)
      core.addColorStop(0, `rgba(255,252,244,${0.95 * intensity})`)
      core.addColorStop(0.55, `rgba(255,224,164,${0.8 * intensity})`)
      core.addColorStop(1, 'rgba(255,224,164,0)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(0, 0, coreR, 0, 2 * Math.PI)
      ctx.fill()
      ctx.restore()

      // 轨道环（点线更克制）+ 刻字（刻字在展示模式淡出）
      ctx.save()
      ctx.setLineDash([2 / scale, 7 / scale])
      for (let i = 0; i < SHELL_RADIUS.length; i++) {
        const r = SHELL_RADIUS[i]
        ctx.beginPath()
        ctx.arc(0, 0, r, 0, 2 * Math.PI)
        ctx.strokeStyle = `rgba(148,158,192,${0.11 + 0.06 * T})`
        ctx.lineWidth = 1 / scale
        ctx.stroke()
        if (T < 0.85) {
          const angle = -Math.PI / 4
          const lx = Math.cos(angle) * r
          const ly = Math.sin(angle) * r
          ctx.font = `500 ${13 / scale}px "Space Grotesk", "PingFang SC", sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = `rgba(148,158,192,${0.3 * (1 - T)})`
          const pad = 16 / scale
          ctx.clearRect(lx - pad, ly - 9 / scale, pad * 2, 18 / scale)
          ctx.fillText(SHELL_LABEL[i], lx, ly)
        }
      }
      ctx.restore()

      // 星座模式：名字常显高亮，图形克制——骨架线只在指针悬到名字上时点亮，
      // 避免所有星座一起画线的杂乱。位置读上一帧的 posCache（引擎静止后与当帧一致）
      labelBoxes.current = []
      if (colorMode === 'community') {
        const pos = posCache.current
        ctx.save()
        for (const c of constellations) {
          const name = namePool[c.rank]
          if (!name) continue // 池子用尽的小社区不命名，只保留配色
          const col = communityColor(c.community)
          const hovered = hoverConst === c.community

          if (hovered) {
            // 轮廓边界：成员凸包沿质心方向外扩，古星图式虚线 + 极淡的域内着色
            const pts: { x: number; y: number }[] = []
            for (const id of c.memberIds) {
              const p = pos.get(id)
              if (p) pts.push(p)
            }
            if (pts.length >= 3) {
              const hull = convexHull(pts)
              let hx = 0
              let hy = 0
              for (const p of hull) {
                hx += p.x
                hy += p.y
              }
              hx /= hull.length
              hy /= hull.length
              const pad = 14
              ctx.save()
              ctx.beginPath()
              hull.forEach((p, j) => {
                const dx = p.x - hx
                const dy = p.y - hy
                const d = Math.hypot(dx, dy) || 1
                const ex = p.x + (dx / d) * pad
                const ey = p.y + (dy / d) * pad
                if (j === 0) ctx.moveTo(ex, ey)
                else ctx.lineTo(ex, ey)
              })
              ctx.closePath()
              ctx.fillStyle = withAlpha(col, 0.05)
              ctx.fill()
              ctx.setLineDash([4 / scale, 5 / scale])
              ctx.strokeStyle = withAlpha(col, 0.4)
              ctx.lineWidth = 1 / scale
              ctx.lineJoin = 'round'
              ctx.stroke()
              ctx.restore()
            }

            const fig = scheme === 'zodiac' ? morphFig.current : null
            if (fig) {
              // 队形连线：连在真实成员星的当前位置之间（星飞到哪线跟到哪，队形逐帧成形）；
              // 没有星可站的顶点用小幽灵点补形，保证图形完整
              const vertexPos = (i: number) => {
                const id = fig.owners[i]
                return (id && pos.get(id)) || fig.mapped[i]
              }
              ctx.save()
              ctx.strokeStyle = withAlpha(col, 0.6)
              ctx.lineWidth = 1.1 / scale
              ctx.lineCap = 'round'
              for (const [a, b] of fig.segs) {
                const pa = vertexPos(a)
                const pb = vertexPos(b)
                ctx.beginPath()
                ctx.moveTo(pa.x, pa.y)
                ctx.lineTo(pb.x, pb.y)
                ctx.stroke()
              }
              ctx.fillStyle = withAlpha(col, 0.55)
              fig.owners.forEach((id, i) => {
                if (id) return
                const p = fig.mapped[i]
                ctx.beginPath()
                ctx.arc(p.x, p.y, 1.3, 0, 2 * Math.PI)
                ctx.fill()
              })
              ctx.restore()
            } else {
              // 二十八宿方案（或无图形数据）：仍用最强互链的生成树骨架
              ctx.strokeStyle = withAlpha(col, 0.5)
              ctx.lineWidth = 0.9 / scale
              for (const [a, b] of c.tree) {
                const pa = pos.get(a)
                const pb = pos.get(b)
                if (!pa || !pb) continue
                ctx.beginPath()
                ctx.moveTo(pa.x, pa.y)
                ctx.lineTo(pb.x, pb.y)
                ctx.stroke()
              }
            }
          }

          let cx = 0
          let top = Infinity
          let k = 0
          for (const id of c.memberIds) {
            const p = pos.get(id)
            if (!p) continue
            cx += p.x
            top = Math.min(top, p.y)
            k++
          }
          if (k >= 3) {
            cx /= k
            const fontPx = 13.5 / scale
            let lx = cx
            let ly = top - 9 / scale
            if (hovered) {
              // 悬停首帧捕获锚点，之后名字钉在原地——队形收拢时名字不许跟着跑
              if (hoverAnchor.current?.c !== c.community) hoverAnchor.current = { c: c.community, x0: lx, y0: ly, x1: lx, y1: ly }
              lx = hoverAnchor.current.x0
              ly = hoverAnchor.current.y0
            }
            ctx.font = `italic 500 ${fontPx}px Georgia, "Songti SC", serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'bottom'
            ctx.fillStyle = hovered ? withAlpha(col, 0.98) : withAlpha(col, 0.72)
            ctx.fillText(name, lx, ly)
            const w = ctx.measureText(name).width
            const pad = 5 / scale
            labelBoxes.current.push({
              c: c.community,
              x0: lx - w / 2 - pad,
              y0: ly - fontPx - pad,
              x1: lx + w / 2 + pad,
              y1: ly + pad,
            })
          }
        }
        ctx.restore()
      }
    },
    [showcase, colorMode, constellations, namePool, scheme, hoverConst],
  )

  const paintNode = useCallback(
    (n: SimNode, ctx: CanvasRenderingContext2D, scale: number) => {
      if (n.x === undefined || n.y === undefined) return
      posCache.current.set(n.id, { x: n.x, y: n.y })
      const T = showcaseT.current
      const color = nodeColor(n)
      // 悬停星座名时，非成员退入暗场——图形只为被指认的那个星座点亮
      const constDim = hoverConst !== null && colorMode === 'community' && n.community !== hoverConst
      const dimmed = (highlightSet !== null && !highlightSet.has(n.id)) || constDim
      const active = n.id === hoverId || n.id === selectedId
      // 新旧类模式的独立视觉语法（heat：1=最新 0=最旧 -1=从未读，null=社区模式）：
      // 尺寸/亮度/光晕三通道全由新旧驱动，不再让互链数抢尺寸通道讲第二个故事。
      // 读取热度按 lastRead 排名，上次修改按 mtime 排名，渲染机制共用
      const heat = n.placeholder
        ? null
        : colorMode === 'freshness'
          ? n.lastRead > 0
            ? 1 - (heatRank.get(n.id) ?? 1)
            : -1
          : colorMode === 'mtime'
            ? 1 - (mtimeRank.get(n.id) ?? 1)
            : null
      const r = heat === null ? nodeR(n) : heat < 0 ? 1.5 : 1.7 + 2.4 * Math.pow(heat, 1.6)

      ctx.save()
      ctx.globalAlpha = dimmed ? 0.1 : 1

      if (n.placeholder) {
        // 悬空链接：细虚线空心圆 —— 「值得写但还没写」的位置
        ctx.setLineDash([2, 3])
        ctx.strokeStyle = withAlpha(color, 0.7)
        ctx.lineWidth = 1 / scale
        ctx.beginPath()
        ctx.arc(n.x, n.y, r + 1, 0, 2 * Math.PI)
        ctx.stroke()
        ctx.setLineDash([])
      } else {
        // 发光体：小而柔的光晕（多档缓释衰减）+ 边缘微羽化的实心核
        // 热度模式讲余烬星座：光晕只留给最热的少数（heat>0.55 才起辉），冷的多数退成
        // 无光晕的暗点——区分度来自图形本身的明暗对比，而不是一片琥珀雾里比透明度
        const glow =
          heat === null ? 1 : heat < 0 ? 0 : Math.pow(Math.max(0, (heat - 0.55) / 0.45), 1.4)
        const effGlow = active ? Math.max(glow, 0.55) : glow
        if (effGlow > 0.02) {
          const bloomR = r * (active ? 3.2 : 2.2 + 0.4 * T)
          ctx.globalCompositeOperation = 'lighter'
          const bloom = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, bloomR)
          const peak = (active ? 0.34 : 0.2) * (dimmed ? 0.3 : 1) * (heat === null ? 1 : effGlow * 1.3)
          bloom.addColorStop(0, withAlpha(color, peak))
          bloom.addColorStop(0.35, withAlpha(color, peak * 0.45))
          bloom.addColorStop(0.7, withAlpha(color, peak * 0.15))
          bloom.addColorStop(1, withAlpha(color, 0))
          ctx.fillStyle = bloom
          ctx.beginPath()
          ctx.arc(n.x, n.y, bloomR, 0, 2 * Math.PI)
          ctx.fill()
          ctx.globalCompositeOperation = 'source-over'
        }

        // 亮度通道：冷记忆连核体一起调暗，从未读的最暗
        const coreA = heat === null ? 1 : heat < 0 ? 0.45 : 0.55 + 0.45 * heat
        const core = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r)
        core.addColorStop(0, withAlpha(color, coreA))
        core.addColorStop(0.72, withAlpha(color, coreA))
        core.addColorStop(1, withAlpha(color, 0.5 * coreA))
        ctx.fillStyle = core
        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, 2 * Math.PI)
        ctx.fill()

        // 环只做反馈不做装饰：悬停/选中才出现，平时零噪音
        if (active) {
          ctx.lineWidth = 1 / scale
          ctx.strokeStyle = withAlpha(color, 0.85)
          ctx.beginPath()
          ctx.arc(n.x, n.y, r * 1.6, 0, 2 * Math.PI)
          ctx.stroke()
        }
        if (n.id === selectedId) {
          ctx.strokeStyle = 'rgba(238,236,228,0.9)'
          ctx.lineWidth = 1.2 / scale
          ctx.beginPath()
          ctx.arc(n.x, n.y, r * 1.6 + 2.5 / scale, 0, 2 * Math.PI)
          ctx.stroke()
        }
      }

      // 标签分层浮现：重要性决定各自的浮现缩放阈值——任何缩放下只有头部节点带字，
      // 越放大露出越多；悬停焦点及其邻居强制点亮；非焦点截断防文字汤
      const inFocus = highlightSet !== null && highlightSet.has(n.id)
      // 热度模式下标签配额也跟热度走：基础缩放只点亮最热的头部，越冷越要放大才露出
      const reveal =
        heat !== null
          ? heat < 0
            ? 3
            : 0.55 + 2.2 * (1 - heat)
          : Math.max(0.5, 1.55 - 0.3 * Math.sqrt(n.readSessions * 2 + n.inDegree + 1))
      let labelAlpha = Math.min(Math.max((scale - reveal) / 0.35, 0), 1)
      if (heat !== null) labelAlpha *= heat < 0 ? 0.55 : 0.6 + 0.4 * heat
      if (active) labelAlpha = 1
      else if (inFocus) labelAlpha = Math.max(labelAlpha, 0.95)
      if (n.placeholder && !active && !inFocus) labelAlpha = 0
      // 星座场景只看星座：节点标题全部收起，直接悬到某颗星上才显示那一条
      if (colorMode === 'community' && !active) labelAlpha = 0
      labelAlpha *= 1 - T
      if (labelAlpha > 0.02 && !dimmed) {
        const full = active || inFocus
        const title = full || n.title.length <= 14 ? n.title : n.title.slice(0, 13) + '…'
        const fontSize = Math.max(11.5 / scale, 2.4)
        ctx.font = `${n.shell === 0 ? 500 : 400} ${fontSize}px "Space Grotesk", "PingFang SC", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.globalAlpha = labelAlpha * (n.placeholder ? 0.5 : 0.88)
        ctx.fillStyle = n.placeholder ? '#7A8098' : '#DDD9CB'
        ctx.fillText(title, n.x, n.y + r + 3.5 / scale)
      }
      ctx.restore()
    },
    [nodeColor, highlightSet, hoverId, selectedId, colorMode, heatRank, mtimeRank, hoverConst],
  )

  // 星座名命中测试：屏幕坐标转图坐标后对包围盒查找（盒子每帧由 paintPre 更新）
  const onWrapMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (colorMode !== 'community') return
      const fg = fgRef.current
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!fg || !rect) return
      const gp = fg.screen2GraphCoords(e.clientX - rect.left, e.clientY - rect.top)
      const hit = labelBoxes.current.find((b) => gp.x >= b.x0 && gp.x <= b.x1 && gp.y >= b.y0 && gp.y <= b.y1)
      const next = hit ? hit.c : null
      setHoverConst((prev) => {
        if (prev !== next) hoverAnchor.current = null
        return prev === next ? prev : next
      })
    },
    [colorMode],
  )

  return (
    <div
      ref={wrapRef}
      className={hoverConst !== null ? 'graph-wrap const-hover' : 'graph-wrap'}
      onMouseMove={onWrapMouseMove}
      onMouseLeave={() => setHoverConst(null)}
    >
      {colorMode === 'community' && !showcase && (
        <button
          className="scheme-toggle"
          onClick={() => {
            const next = scheme === 'zodiac' ? 'mansions' : 'zodiac'
            localStorage.setItem('lens-constellation-scheme', next)
            setScheme(next)
          }}
          title={t('切换星座命名方案', 'Switch constellation naming scheme')}
        >
          ⇄ {scheme === 'zodiac' ? t('十二星座', 'Zodiac') : t('二十八宿', '28 Mansions')}
        </button>
      )}
      <ForceGraph2D<SimNode, SimLink>
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={graphData}
        nodeId="id"
        nodeVal={(n) => 3 + n.inDegree}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(n, color, ctx) => {
          if (n.x === undefined || n.y === undefined) return
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x, n.y, Math.max(nodeR(n) + 4, 7), 0, 2 * Math.PI)
          ctx.fill()
        }}
        onRenderFramePre={paintPre}
        autoPauseRedraw={false}
        linkVisibility={(l) => {
          if (linkMode === 'hidden') return false
          if (linkMode === 'focus') {
            return (
              highlightSet !== null &&
              highlightSet.has(endpointId(l.source)) &&
              highlightSet.has(endpointId(l.target))
            )
          }
          return true
        }}
        linkColor={(l) => {
          const fade = 1 - showcaseT.current * 0.75
          const inFocus =
            highlightSet !== null &&
            highlightSet.has(endpointId(l.source)) &&
            highlightSet.has(endpointId(l.target))
          if (highlightSet !== null && !inFocus) return 'rgba(120,130,160,0.03)'
          if (inFocus) return 'rgba(200,208,232,0.6)'
          if (l.dangling) return `rgba(122,128,152,${0.14 * fade})`
          return `rgba(122,132,164,${0.09 * fade})`
        }}
        linkWidth={(l) => Math.min(0.4 + l.weight * 0.2, 1.4)}
        linkCurvature={0.18}
        linkLineDash={(l) => (l.dangling ? [1, 2] : l.cross ? [3, 3] : null)}
        onNodeHover={(n) => setHoverId(n?.id ?? null)}
        onNodeClick={(n) => onSelect(n.id)}
        onBackgroundClick={() => onSelect(null)}
        onEngineStop={() => {
          engineIdle.current = true
          if (!didFit.current) {
            didFit.current = true
            fgRef.current?.zoomToFit(500, 70)
          }
        }}
        cooldownTicks={200}
        warmupTicks={60}
      />
    </div>
  )
}
