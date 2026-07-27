import fs from 'node:fs'
import type { EntryDetail, GraphPayload, MemNode } from '../shared/types.js'

/**
 * 演示模式（LENS_DEMO=1 / npx --demo）：不扫描本机任何文件，直接供给打包好的样例图谱。
 * 样例由 scripts/export-demo.ts 从一份真实记忆库导出：结构（互链/轨道/读取热度）为真，
 * 标题、slug、桶名全部替换为占位——任何人 60 秒内看到真实形状的星图，而不泄露任何内容。
 */

export interface DemoGraphs {
  zh: GraphPayload
  en: GraphPayload
}

/** 路径相对 cwd：dev 从仓库根启动，npx 由 bin/cli.js chdir 到包根 */
export function loadDemoGraphs(): DemoGraphs {
  return {
    zh: JSON.parse(fs.readFileSync('./demo/graph.zh.json', 'utf8')) as GraphPayload,
    en: JSON.parse(fs.readFileSync('./demo/graph.en.json', 'utf8')) as GraphPayload,
  }
}

export function pickDemoLang(acceptLanguage: string | undefined): keyof DemoGraphs {
  return (acceptLanguage ?? '').toLowerCase().includes('zh') ? 'zh' : 'en'
}

/** 详情抽屉的合成条目：标题与星图一致，正文解释这是演示占位 */
export function demoEntry(n: MemNode, lang: keyof DemoGraphs): EntryDetail {
  const body =
    lang === 'zh'
      ? [
          `- ${n.title}——演示占位正文。`,
          '- 图谱结构（互链 / 轨道分层 / 读取热度）来自一份真实记忆库，标题与正文已全部替换。',
          '',
          '**Why:** 想看你自己的记忆？运行 `npx memory-is-all-you-need`（默认读 `~/.claude/projects`）。',
        ].join('\n')
      : [
          `- ${n.title} — demo placeholder body.`,
          '- The graph structure (links / orbits / read heat) comes from a real memory base; every title and body has been replaced.',
          '',
          '**Why:** Want to see your own memory? Run `npx memory-is-all-you-need` (reads `~/.claude/projects` by default).',
        ].join('\n')
  return {
    id: n.id,
    title: n.title,
    frontmatter: {
      name: n.slug,
      description: lang === 'zh' ? `${n.title}（演示占位）` : `${n.title} (demo placeholder)`,
      metadata: { type: n.type },
    },
    body,
    bytes: n.bytes,
    mtime: n.mtime,
    path: '(demo)',
    copies: n.buckets.map((b) => ({ bucket: b, path: '(demo)', bytes: n.bytes, mtime: n.mtime })),
  }
}
