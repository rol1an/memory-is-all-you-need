import type { MemType } from '../../shared/types'

/** 四类记忆的功能色板（深空底上的高亮光源色，配加法混合光晕） */
export const TYPE_COLOR: Record<MemType, string> = {
  feedback: '#FFB454', // 琥珀 —— 纠偏经验，最珍贵
  user: '#EAE5D6', // 月白 —— 用户身份与偏好
  project: '#7FB2FF', // 青蓝 —— 项目进行时
  reference: '#B49AFF', // 紫 —— 外部指针
  unknown: '#78809A',
}

const alphaCache = new Map<string, string>()
/** hex → rgba，带缓存（渲染帧内高频调用） */
export function withAlpha(hex: string, a: number): string {
  const key = `${hex}|${a}`
  const hit = alphaCache.get(key)
  if (hit) return hit
  const m = hex.match(/^#([0-9a-f]{6})$/i)
  let out = hex
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16)
    const g = parseInt(m[1].slice(2, 4), 16)
    const b = parseInt(m[1].slice(4, 6), 16)
    out = `rgba(${r},${g},${b},${a})`
  }
  alphaCache.set(key, out)
  return out
}

export const TYPE_LABEL: Record<MemType, string> = {
  feedback: 'feedback',
  user: 'user',
  project: 'project',
  reference: 'reference',
  unknown: '未标注',
}

export const SHELL_LABEL = ['内核', '中核', '外核'] as const
/** 各层节点的轨道半径（图坐标） */
export const SHELL_RADIUS = [80, 210, 350] as const

const COMMUNITY_PALETTE = [
  '#E5A158', '#7FA9DB', '#9D91D9', '#6FBF9E', '#D98B9C',
  '#C9C46A', '#6FB8C9', '#C98A5E', '#8FA86F', '#B487C9',
]

export function communityColor(c: number): string {
  if (c < 0) return '#5A6175'
  return COMMUNITY_PALETTE[c % COMMUNITY_PALETTE.length]
}

function lerp(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t)
}

const toHex = (v: number) => v.toString(16).padStart(2, '0')

// 必须输出 hex：withAlpha 只解析 #rrggbb，rgb() 字符串会让透明度被静默忽略
function mix(c1: [number, number, number], c2: [number, number, number], t: number): string {
  return `#${toHex(lerp(c1[0], c2[0], t))}${toHex(lerp(c1[1], c2[1], t))}${toHex(lerp(c1[2], c2[2], t))}`
}

type Ramp = Array<[number, [number, number, number]]>

function rampColor(stops: Ramp, t: number): string {
  const x = Math.min(Math.max(t, 0), 1)
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      return mix(c0, c1, (x - t0) / (t1 - t0))
    }
  }
  return mix(stops[stops.length - 1][1], stops[stops.length - 1][1], 0)
}

/** 余烬降温曲线：白炽 → 琥珀 → 余烬红 → 冷板岩。中段过红保饱和，避免琥珀直混板岩的浑浊卡其 */
const HEAT_STOPS: Ramp = [
  [0, [255, 237, 204]],
  [0.3, [255, 174, 79]],
  [0.62, [181, 106, 80]],
  [1, [78, 88, 110]],
]

/** 月光降温曲线（上次修改模式）：刚改过的亮月白 → 青蓝 → 暗板岩，与余烬琥珀拉开 */
const MTIME_STOPS: Ramp = [
  [0, [244, 248, 255]],
  [0.3, [156, 195, 255]],
  [0.62, [94, 118, 168]],
  [1, [58, 70, 94]],
]

/** 从未被读的死记忆候选：比最冷还暗一档 */
export const NEVER_READ_COLOR = '#39404F'

/** 读取热度色：t 为热度排名分位（0=最热 1=最冷）。用排名而非绝对天数——数据挤在近几天时仍有满量程对比 */
export function heatColor(t: number): string {
  return rampColor(HEAT_STOPS, t)
}

/** 上次修改色：t 为修改新旧排名分位（0=刚改过 1=最陈旧） */
export function mtimeColor(t: number): string {
  return rampColor(MTIME_STOPS, t)
}

export function timeAgo(mtime: number, now = Date.now()): string {
  if (!mtime) return '—'
  const days = Math.floor((now - mtime) / 86_400_000)
  if (days <= 0) return '今天'
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}
