/**
 * 极简双语：第一屏骨架文案跟浏览器语言走（zh → 中文，其余英文）。
 * 只覆盖 chrome（顶栏/侧栏/遮罩），记忆正文本身是用户自己的语言，不翻译。
 */
export const isZh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')

export const t = (zh: string, en: string): string => (isZh ? zh : en)
