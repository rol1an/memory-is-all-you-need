import type { EntryDetail, GraphPayload } from '../shared/types.js'

/**
 * 匿名截图模式（LENS_ANONYMIZE=1）：真实图谱的结构原样保留（互链/分层/读取热度/社区），
 * 只把会泄露内容的文字——标题、描述、桶名——在 API 出口替换成占位文案。
 * 用途：对着真实数据截演示图/录屏，不暴露记忆内容。详情接口不受影响，仅星图脱敏。
 */

const BUCKET_ALIASES = [
  'Code-orbit-app', 'Code-infra', 'Code-experiments', 'claudetools', 'notes',
  'scratch', 'sandbox', 'playground', 'archive', 'misc',
]

const TITLE_POOL = [
  '构建与测试命令速查', 'API 错误信封约定', '数据库迁移三条铁律', '代码评审自查清单', '包管理器用 pnpm',
  '发布火车节奏', 'v2 API 冻结时间表', 'CI flaky 用例先隔离再修', '错误日志必须带请求上下文', '禁止全局单例传配置',
  'WS 断线重连策略已定稿', '设计令牌文档入口', 'E2E 种子数据的生成方式', '画布性能预算 16ms', 'PR 标题约定',
  '界面词汇表', '旧版登录流程（已废弃）', '待清理的开关列表', 'Sentry 告警分级习惯', '新人入职清单',
  '品牌素材位置', '2025 复盘要点', '部署 runbook', '先回滚再排查', 'Postgres 慢查询排查手册',
  '资源限额别拍脑袋', '密钥轮换排期', 'TF 模块命名规范', '备份要演练恢复', '云成本看板',
  '值班交接模板', '遗留虚拟机清单', '常用监控面板索引', '旧 nginx 调优记录（存档）', '写作偏好：短句、少形容词',
  '会议纪要模板', '读书笔记流程', '上午免打扰', '博客草稿索引', '演讲选题池',
  '年度回顾问题清单', '常用快捷键备忘', '播客待听队列', '出行清单', '缓存键 A/B 实验结论',
  '向量召回小样本实验', 'WebGPU 画布渲染试验', 'SQLite WAL 压测数据', 'LRU 淘汰参数扫描', '提示词缓存命中账本',
  'wasm diff 算法基准', '空闲调度器原型笔记', 'CRDT 选型笔记', '离线优先方案取舍', '图片管线压缩对比',
  '火焰图采集流程', '特征仓库调研存档', '基准测试脚手架用法', '放弃 GraphQL 的理由存档', '限流器令牌桶参数',
  'monorepo 拆分预研', 'OTel 埋点试点结论', '大改动先进计划模式', '写入守卫 hook 的规则', '子代理扇出的适用场景',
  'MEMORY.md 注入上限事实', 'headless 批量跑法', '常用 MCP 服务器清单', 'skill 与 rule 的分工', 'transcript 存储位置',
  'compact 后什么会留下', '权限模式差异备忘', '并行会话用 worktree 隔离', '提示词动词要具体', '上下文预算的分配习惯',
  '评测回路的搭法', 'diff 审查流程', '会话命名约定', '工具报错的重试原则', '提交粒度与共变原则',
  '长任务的监控方式', '模型选型的经验法则', '同步冲突的合并策略', '光标广播节流 200ms', '撤销栈上限与内存',
  '导出 PDF 的字体坑', '移动端手势映射表', '白板权限模型定稿', '评论锚点漂移的修法', '缩略图后台任务',
  '存储配额分档', '搜索索引重建时机', '表情回应的范围约定', '模板库运营流程', '无障碍焦点环规范',
  '粘贴行为规则', '回放脱敏清单', '计费回调重试语义', '流失看板入口', '内测用户委员会名单位置',
  '性能门禁在 CI 的阈值', '图标命名规则', '告警路由矩阵', 'CDN 缓存规则备忘', '连接池参数定稿',
  '对象存储生命周期策略', 'VPN 排障三步', '基础镜像统一约定', '预发数据刷新节奏', '域名续费日期',
  '压测手册入口', '事故分级定义', 'IPv6 灰度笔记', 'KMS 密钥使用规范', '周回顾仪式',
  '收件箱清零规则', '学习日志格式', '演讲彩排清单', '书摘进知识库的路径', '工位设备清单',
  '咖啡预算线', '家庭日历同步方式', '副业项目取舍标准', '站立提醒的设置', '灰度放量的节奏表',
  '慢接口 TOP10 台账', '客服工单归因口径', '数据脱敏清单', '实验平台指标口径', '崩溃率红线与响应',
  '依赖升级的窗口期', '第三方配额与限速', '许可证合规备忘', '容量规划的粗算法', '故障演练日程',
  '接口废弃流程', '埋点命名规范', '离职交接清单模板', '开源贡献流程', '技术雷达季度笔记',
  '团队术语表', '周边工具账号索引', '录屏与截图规范', '文档目录结构约定', '晨会三问模板',
]

export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// 最近一次 anonymizeGraph 的映射缓存：entry 脱敏与星图保持同名
let titleCache = new Map<string, string>()
let bucketCache = new Map<string, string>()

export function anonymizeGraph(g: GraphPayload): GraphPayload {
  // 桶：按条目数降序映射到固定假名，全程稳定
  const order = [...g.buckets].sort((a, b) => b.count - a.count)
  const bucketAlias = new Map<string, string>()
  order.forEach((b, i) => bucketAlias.set(b.id, BUCKET_ALIASES[i % BUCKET_ALIASES.length]))

  // 标题：按 id 哈希排序后顺序领取假标题，同一数据集下稳定且互不重复（池子用尽才复用）
  const sorted = [...g.nodes].sort((a, b) => hash(a.id) - hash(b.id))
  const titleOf = new Map<string, string>()
  sorted.forEach((n, i) => titleOf.set(n.id, TITLE_POOL[i % TITLE_POOL.length]))
  titleCache = titleOf
  bucketCache = bucketAlias

  return {
    ...g,
    buckets: g.buckets.map((b) => ({
      ...b,
      id: bucketAlias.get(b.id) ?? b.id,
      label: bucketAlias.get(b.id) ?? b.label,
      dir: '(anonymized)',
    })),
    nodes: g.nodes.map((n) => ({
      ...n,
      title: titleOf.get(n.id) ?? n.title,
      description: '',
      bucket: bucketAlias.get(n.bucket) ?? n.bucket,
      buckets: n.buckets?.map((b) => bucketAlias.get(b) ?? b) ?? n.buckets,
    })),
  }
}

/** 详情抽屉脱敏：标题与星图同名，正文/frontmatter/路径/副本桶名全部换占位 */
export function anonymizeEntry(e: EntryDetail): EntryDetail {
  const title = titleCache.get(e.id) ?? TITLE_POOL[hash(e.id) % TITLE_POOL.length]
  const type = (e.frontmatter as { metadata?: { type?: string } })?.metadata?.type
  return {
    ...e,
    title,
    frontmatter: { name: 'demo-entry', description: `${title}的一句话概括（占位）`, metadata: { type } },
    body: [
      `- ${title}的要点记录，短句列表。`,
      '- 匿名截图模式：真实正文已在服务端替换为占位文案。',
      '',
      '**Why:** 结构是真的，文字是假的——录屏/截图不泄内容。',
    ].join('\n'),
    path: '(anonymized)',
    copies: e.copies.map((c) => ({ ...c, bucket: bucketCache.get(c.bucket) ?? 'bucket', path: '(anonymized)' })),
  }
}
