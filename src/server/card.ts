import type { InboxItem } from '../shared/types.js'

/**
 * 收件箱审核卡片（Card 1.0）——决策式两行体：结论 + 灰色来源。
 * 按钮是回调型（value 带路由信息，点击不跳转），由常驻服务的事件监听器处理并原地更新卡片。
 * notify-card（每日发卡）与 card-listener（点击后重渲）共用本模块。
 */

const LENS = 'http://localhost:5611'
const MAX_CARDS = 5

export function hintOf(item: InboxItem): string {
  if (item.hint) return item.hint
  return item.kind === 'repeated-constraint'
    ? `你在多个会话里反复输入过（${item.evidence.length} 条证据）`
    : `来自你的飞书消息${item.evidence[0]?.source ? `（${item.evidence[0].source.slice(0, 20)}）` : ''}`
}

export function buildReviewCard(pending: InboxItem[]): any {
  if (pending.length === 0) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '收件箱清空了' }, template: 'green' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '这批候选都审完了。点"记住"的会在下次 Claude Code 会话写成正式记忆。' } },
      ],
    }
  }

  const shown = pending.slice(0, MAX_CARDS)
  const elements: any[] = []
  shown.forEach((item, idx) => {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${idx + 1}. ${item.title}**\n<font color="grey">${hintOf(item)}</font>`,
      },
    })
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '记住' },
          type: 'primary',
          value: { lens: 'inbox', bucket: item.bucket, id: item.id, action: 'accept' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '不记' },
          type: 'default',
          value: { lens: 'inbox', bucket: item.bucket, id: item.id, action: 'dismiss' },
        },
      ],
    })
    if (idx < shown.length - 1) elements.push({ tag: 'hr' })
  })
  const tail =
    pending.length > shown.length ? `还有 ${pending.length - shown.length} 条没放下，去观测台看` : '细节和草稿全文在观测台里'
  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', text: { tag: 'plain_text', content: tail }, type: 'default', url: `${LENS}/` }],
  })

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${pending.length} 条新记忆等你点头` },
      template: 'orange',
    },
    elements,
  }
}
