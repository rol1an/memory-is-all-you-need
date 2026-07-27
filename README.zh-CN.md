# Memory Is All You Need 🔭

[English](./README.md) | **简体中文**

> 你的 Agent 每天都在读写记忆。你上一次亲眼看见它的记忆，是什么时候？

```bash
npx memory-is-all-you-need --demo
```

![实录——记忆星系、读取热度与社区聚类](https://raw.githubusercontent.com/rol1an/memory-is-all-you-need/master/docs/demo.gif)

## 从 Anthropic 的四象限说起

Anthropic 在官方博客《[A field guide to Claude Fable 5: Finding your unknowns](https://claude.com/blog/a-field-guide-to-claude-fable-finding-your-unknowns)》里，把「你和 Agent 之间的信息」画成了一个四象限：

| 象限 | 原文的定义 | 长什么样 |
|---|---|---|
| **已知的已知** | "This is essentially what is in my prompt."——你明确告诉 Agent 的 | 需求、约束、验收标准 |
| **已知的未知** | 你意识到自己还没想清楚的 | 待讨论的设计决策——对话本身要解决的事 |
| **未知的已知** | 显而易见到你从不会写下来、但见到就能认出的 | 约定俗成：剪纸用剪刀而不是刻刀，爸爸的爸爸是爷爷 |
| **未知的未知** | 完全没考虑过的 | 盲区——原文推荐用 "blindspot pass" 主动逼它现形 |

任务的成败大半取决于第一象限的质量：Agent 只知道你告诉它的。但同样的约束每次对话都重打一遍，显然不可持续——所以 Agent 需要**记忆**：写下来一次，之后每次会话自动注入。

**记忆，就是「已知的已知」的持久化层。**

## 但这一层是看不见的

Anthropic 把 [Claude Code 的记忆](https://code.claude.com/docs/en/memory)做成了纯文件：每个项目一个 `~/.claude/projects/<project>/memory/` 目录，`MEMORY.md` 做索引（每次会话注入前 200 行 / 25KB），正文按需读取，条目之间用 `[[wikilink]]` 互链。

纯文件意味着透明、可编辑、无锁定——这是对的。但它也意味着记忆只是躺在文件夹里的一堆 markdown：**看不见全貌的形状，看不见条目之间的关系，更看不见 Agent 到底有没有在用它们。**

Memory Is All You Need 就是给这一象限造的观测台：把记忆变成一张可交互的星图——每条记忆是一颗发光体，wikilink 是引力，轨道由一个别处看不到的事实决定：**Agent 在真实会话里到底读过它多少次。** 然后派管线去其他象限打猎，把猎物不断搬进这一层。

## 它回答四个问题

**1. 它到底记了什么？**
翻记忆要开编辑器一个个点文件。现在是一张力导向星图 + 全文抽屉：搜索、筛选、三种着色（读取热度 / 上次修改 / 社区聚类），一眼看全几百条记忆的形状。默认就停在读取热度——打开即是最要紧的那个问题。

**2. 记忆之间是什么关系？**
`[[wikilink]]` 埋在正文里根本看不见。现在是可见的边、Louvain 自动社区、孤儿节点和悬空引用一键透镜。选中任意一条记忆，它的邻居连带边一起点亮，其余退入暗场：

![关系透镜——选中记忆点亮邻居与连线，右侧抽屉展开全文](https://raw.githubusercontent.com/rol1an/memory-is-all-you-need/master/docs/link-lens.png)

**3. 它真的在用这些记忆吗？**
这是黑盒里最黑的一块。观测台扫描全部会话 transcript（含 subagent）里的真实 `Read` 事件，把记忆分成三层轨道：

| 轨道 | 判据 | 含义 |
|---|---|---|
| 内核 | ≥ 4 个会话读过正文 | Agent 真正依赖的记忆 |
| 中核 | 读过 1–3 次 | 偶尔被需要 |
| 外核 | **从未被读** | 死记忆候选——索引行每次注入、白白烧 token |

不是猜的，不是模型评的，是数出来的。

![读取热度——热记忆像余烬在烧，冷的多数退成暗点](https://raw.githubusercontent.com/rol1an/memory-is-all-you-need/master/docs/hero.png)

**4. 记忆从哪来？**
不再只靠"帮我记一下"——见下面的供给侧。

## 供给侧：从其他象限往回搬

| 管线 | 搬的是什么 | 用模型吗 |
|---|---|---|
| 观测台本身 | 管好已知的已知：管理、清理、死记忆定位 | 否 |
| `npm run mine` | 已知的已知里的**漏网者**：你在一次次 prompt 里反复重打、却从没固化的约束（3-gram 相似句聚类 + 并查集，附六道降噪防线） | 否 |
| `npm run scan:feishu` | **未知的已知**：你从没想过要写下来的默会认知，散落在自己发出的飞书消息里。审核卡片正是原文说的那一刻——"见到就能认出" | 仅起草 |
| 决策问答捕获（规划中） | **未知的未知**：主动提问逼盲区现形——blindspot pass 的固化版 | — |

（已知的未知不需要管线——你意识到没想清楚的事，属于对话本身。）

## 人在回路，但人只点头

工具的立场：**看见和起草是工具的事，写记忆的永远是 Claude Code 本人**（经它自己的写入规范），而你只做决定。

- **评论 → 修改**：在观测台对任意记忆留评 → 下次 Claude Code 会话被 SessionStart hook 注入评论 → CC 亲手改，改完标 done。
- **候选 → 审核 → 写入**：供给管线产出候选进收件箱（每桶 `.lens-inbox.jsonl`）→ 飞书卡片推送到你的专属群，**「记住 / 不记」按钮回调式原地更新，不跳浏览器** → 接受项注入给 CC 写成正式记忆。忽略即墓碑，同类内容永不再提案。

## 原则：结构性数据零大模型

图谱解析、分层、聚簇、查重、约束挖掘——全部确定性代码。大模型在整个系统里只出现一次、只有起草权（飞书扫描器），并且网关地址由你自己配置，可以指向私有部署。**机器逻辑能做的事，不请模型。** 这既是成本立场，也是掌控感立场：确定性的管线才能被信任、被审计。

## 快速开始

60 秒零配置——内置样例星系（结构从一份真实记忆库导出，文字全部替换；不读你机器上的任何文件）：

```bash
npx memory-is-all-you-need --demo
```

然后指向你自己的记忆（默认读 `~/.claude/projects`，只绑 localhost）：

```bash
npx memory-is-all-you-need
```

参数：`--dir <path>` 覆盖记忆目录，`--port <n>` 换端口（默认 5611），`--anonymize` 保留真实图谱但标题全换占位（可安全截图），`-h` 看其余。界面骨架文案跟浏览器语言走（中 / 英）。

### 本地开发

```bash
npm install
npm run dev    # server :5611（解析 + WebSocket）+ web :5610（Vite 热更新）
```

打开 http://localhost:5610 。生产模式（前后端同端口）：

```bash
npm run build
node dist-server/index.js   # http://localhost:5611
```

### 常驻化（macOS）

```bash
bash scripts/install-launchd.sh
```

装两个 LaunchAgent：`com.claude-lens.server`（KeepAlive 常驻 :5611）+ `com.claude-lens.daily-scan`（每天 21:30 跑 挖掘 → 飞书扫描 → 发审核卡片）。日志在 `~/Library/Logs/claude-lens/`。

### 配置（可选功能才需要）

```bash
cp scripts/scan-job.env.example scripts/scan-job.env   # 已 gitignore
```

| 变量 | 作用 |
|---|---|
| `LENS_LLM_URL` / `LENS_LLM_MODEL` / `LENS_LLM_KEY` | 飞书扫描器的 OpenAI 兼容网关 |
| `LENS_LLM_EXTRA_HEADER` / `LENS_LLM_EXTRA_HEADER_CMD` | 网关需要动态凭证（如短时 JWT）时：header 名 + 取值命令 |
| `LENS_SCAN_BUCKET` | 飞书候选写入哪个记忆桶 |
| `LENS_SCAN_PERSONA` | 起草 prompt 里对你的称呼 |
| `LENS_NOTIFY_CHAT` | 审核卡片群 chat_id（缺省按群名「记忆观测台」搜索） |
| `LENS_ANONYMIZE=1` | 截图模式：星图保留真实结构，标题和桶名全部换成占位文案——对着真实数据截演示图不泄内容 |
| `LENS_DEMO=1` | 演示模式（同 `--demo`）：供给内置样例星系，只读，不扫描本机任何文件 |

飞书链路（扫描 + 审核卡片）依赖已登录的 [lark-cli](https://open.feishu.cn/)；不配则纯本地功能（星图/编辑/评论/约束挖掘）全部可用。

## 隐私设计

- 服务只绑 `127.0.0.1`，不对外监听。
- 记忆文件、transcript、评论、收件箱全部留在本机文件系统，**没有数据库，没有云**。
- 唯一可能把内容送出机器的是可选的飞书扫描器——送到哪个 LLM 网关由你配置。

## 技术

Vite + React + react-force-graph-2d（canvas 自绘发光体）｜ Hono ｜ graphology（Louvain）｜ gray-matter ｜ chokidar + WebSocket 实时推送 ｜ 文件系统就是数据库。

```
src/server/   Hono API · 记忆解析(scan) · transcript 读取统计(readstats) · 挖掘器(miner)
              飞书扫描(feishu-scan) · 审核卡片(notify-card/card-listener) · chokidar/WS
src/web/      星图(GraphCanvas) · 详情抽屉 · 收件箱 · 搜索
src/shared/   前后端共享类型与分层规则
scripts/      LaunchAgent 模板与安装脚本 · 每日采集任务
```

## 路线图

1. ✅ 星图 + 详情抽屉 + 增删改连 + 评论闭环
2. ✅ 运行时分层（transcript Read 事件）+ 供给侧双管线 + 飞书审核卡片 + 常驻化
3. token 账本：记忆注入的精确计量与趋势
4. 会话 transcript 视图：Agent JSON 流的时间线可视化——记忆只是第一个镜头，目标是整个 Agent 过程的可观测
5. 决策问答捕获（"未知的未知"象限）

## License

MIT
