/** 零模型文本相似度原语：字符 3-gram 集合 + Jaccard / 包含度 */

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s，。、；：！？«»“”‘’"'`()（）【】\[\]<>《》.,;:!?~\-—_*#/\\|]+/g, '')
}

export function grams(s: string, n = 3): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  for (const g of small) if (big.has(g)) inter++
  return inter / (a.size + b.size - inter)
}

/** a 被 b 包含的程度：|a∩b| / |a|（短句 vs 长文时比 Jaccard 合理） */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return inter / a.size
}

export class UnionFind {
  private parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  union(a: number, b: number) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[ra] = rb
  }
}
