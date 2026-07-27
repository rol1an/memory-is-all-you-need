/**
 * 记忆桶名 = 会话启动 cwd 的编码（`/` 和 `_` → `-`），如 /Users/me/Code → -Users-me-Code。
 * 短名 = 去掉 home 目录前缀。前缀由 server 从 os.homedir() 算出：
 * server 侧模块加载时注入，web 侧从 /api/graph 的 homePrefix 字段注入。
 */
let homePrefix: string | null = null

export function setBucketPrefix(p: string) {
  homePrefix = p
}

export function shortBucket(b: string): string {
  if (homePrefix && b.startsWith(homePrefix)) return b.slice(homePrefix.length).replace(/^-/, '')
  // 前缀未注入时的兜底：常见 macOS/Linux home 形态
  return b.replace(/^-(Users|home)-[^-]+-?/, '')
}
