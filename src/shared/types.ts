export type MemType = 'user' | 'feedback' | 'project' | 'reference' | 'unknown'

/** 0 = 内核, 1 = 中核, 2 = 外核 */
export type Shell = 0 | 1 | 2

/**
 * 分层规则 = 运行时重要性：agent 实际打开正文的会话数（从 transcript 挖出的 Read 事件）。
 * ≥ kernel 个会话读过为内核，≥ mid 为中核，从未被读为外核（占位节点固定外核）。
 */
export const SHELL_RULE = { kernel: 4, mid: 1 } as const

/** 同一 slug 在多个桶重复时合并为一个节点 */
export interface MemNode {
  /** 即 slug，全局唯一 */
  id: string
  slug: string
  /** 最新副本所在桶 */
  bucket: string
  /** 含有此条目的全部桶 */
  buckets: string[]
  /** 短中文标题，取自 MEMORY.md 索引；缺失时退化为正文一级标题或 slug */
  title: string
  description: string
  type: MemType
  bytes: number
  /** 最新副本的 epoch ms */
  mtime: number
  /** 被多少条不同记忆引用 */
  inDegree: number
  /** 引用了多少条不同记忆 */
  outDegree: number
  /** 有多少个会话真正打开过正文（transcript Read 事件） */
  readSessions: number
  /** 最后一次被读，epoch ms；0 = 从未被读 */
  lastRead: number
  shell: Shell
  community: number
  /** 悬空链接占位节点（[[x]] 找不到对应文件） */
  placeholder?: boolean
}

export interface MemLink {
  source: string
  target: string
  /** 引用出现总次数 */
  weight: number
  /** 引用双方不共存于任何一个桶（跨桶引用） */
  cross?: boolean
  /** 指向占位节点的边 */
  dangling?: boolean
}

export interface BucketInfo {
  id: string
  /** 去掉 home 目录前缀的短名 */
  label: string
  dir: string
  count: number
  indexBytes: number
  indexLines: number
}

export interface GraphStats {
  files: number
  merged: number
  links: number
  orphans: number
  placeholders: number
}

export interface GraphPayload {
  nodes: MemNode[]
  links: MemLink[]
  buckets: BucketInfo[]
  stats: GraphStats
  /** home 目录的桶名编码前缀，web 侧用它把桶名缩成短名 */
  homePrefix: string
  generatedAt: number
}

export interface EntryCopy {
  bucket: string
  path: string
  bytes: number
  mtime: number
}

/** 记忆候选收件箱：供给侧管线（约束挖掘/飞书扫描）的产出，人审后由 CC 写入 */
export type InboxKind = 'repeated-constraint' | 'feishu'
export type InboxStatus = 'pending' | 'accepted' | 'dismissed' | 'done'

export interface InboxEvidence {
  /** 会话 id 或飞书会话名 */
  source: string
  ts: number
  text: string
}

export interface InboxItem {
  id: string
  kind: InboxKind
  bucket: string
  title: string
  /** 一行人话来源说明，卡片/列表的次要信息（如"你在 5 个会话里反复输入过"） */
  hint?: string
  /** 建议的记忆正文草稿（CC 写入时的起点，非最终文本） */
  draft: string
  evidence: InboxEvidence[]
  suggestedType: MemType
  status: InboxStatus
  createdAt: number
  /** 归一化签名：挖掘器防重复提案（含已忽略的墓碑） */
  signature: string
}

export interface LensComment {
  id: string
  slug: string
  bucket: string
  /** 选中的原文片段（锚点，可为空 = 整条评论） */
  quote: string
  comment: string
  createdAt: number
  status: 'pending' | 'done'
  doneAt?: number
}

export interface EntryDetail {
  id: string
  title: string
  frontmatter: Record<string, unknown>
  /** 最新副本的正文 */
  body: string
  bytes: number
  mtime: number
  path: string
  /** 全部副本（含正在显示的这份），按 mtime 降序 */
  copies: EntryCopy[]
}
