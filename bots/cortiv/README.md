<!-- Owner: bots/cortiv/index.ts, bots/cortiv/persona/persona.ts -->

# bots/cortiv

直播 bot,默认展示名可缇Corti。Persona `CortiV` 继承 `Cormini`，增加观众档案和交接后的后台整理。

## 启动

```bash
pnpm start cortiv
```

默认控制台地址：`http://127.0.0.1:7789/`。

## World

| World | 功能与配置 |
|---|---|
| `terminal` | 控制台聊天。 |
| `minecraft` | Minecraft 操作、任务队列和客户端托管。 |
| `pvz` | 植物大战僵尸操作、任务队列和游戏托管，由扩展 `cortico-world-pvz` 提供，默认关闭。 |
| `vtuber` | L1–L4 演出、TTS 声卡输出、演出流 SSE `http://127.0.0.1:7792/stream` 与弹幕输入 WS，由扩展 `cortico-world-vtuber` 提供。 |
| `bilibili` | 直播间只读接入：弹幕、礼物、SC、上舰和观众统计。默认关闭，启用前填写 `worlds.bilibili.roomId`；`sessdata` 可提供登录凭证。 |
| `asr` | 麦克风语音识别，由扩展 `cortico-world-asr` 提供，默认关闭。 |

未安装的扩展 World 显示为不可用。VTS 首次连接授权后可将 `VTS_AUTH_TOKEN` 写入部署 `.env`。

## 事件投递

默认将外部事件正文放入合成的 `external_event_frame` 工具回执，user 消息用于内部系统文本。

## 按需参考资料

`references.indexFiles` 配置工作区中的资料索引；`references.enabled` 开启后，主会话与长期复盘可见有界主题目录。
`reference_guide` 的 `catalog` 分页读主题，`guides` 分页读候选，`detail` 读一个活动，`clear` 关闭阅读分支。
`topic_key` 来自目录，`activity_id` 来自候选卡；`offset` 从0开始。当前视图默认预算1200个估算token，旧读取仍在原始账本中，近期请求历史由 `foreground` 单独管理。

资料由 `imported_reference_index` 的 `categories[{file,ideas,summary?}]` 与分类文件的 `activities` 提供；可选 `summary` 是完整主题范围的短描述，避免长活动清单的末尾被省略。每项活动保留 `id,title,requires,firstStep,verify,leaveWhen,capability,sourceIds,provenance`。
索引目录限定类别的词法和实体路径，资料正文来自Memory现读。服务器知识可用独立索引配置；操作能力和技能用法以当前World工具说明、实时帮助和回执为准。
读取不会自动变成亲历记忆。尝试和结果由主意识依据实际终态或观察记录，受理回执只证明受理。

可选 `fastReference` 将短场景与主题卡送给快速分类服务，每次只用一道选择题推荐主题，支持无需新资料的选择。
它在后台运行，通过门槛时展开少量候选并唤醒下一次投递；详细活动由主意识选择。明确打开的分支优先，低置信度、服务故障和过期结果保留现有计划。
分类、输入事件游标和延迟记入 `reference-routing` 日志。配置与契约见 [ATTENTION.md](persona/ATTENTION.md)。

## Memory

Memory 使用工作区文件，由 [Persona](persona/persona.ts) 管理。

| 功能 | 行为 |
|---|---|
| 观众档案 | `viewers/<来源>/<数字ID>.md`，首行为摘要。同一 `senderKey` 在当前上下文窗口首次出现时，档案首行与外部事件同批注入。交接清除已唤起记录，热重启保留；没有稳定身份键的事件不触发档案召回。后台整理追加档案时同时更新首行摘要。 |
| 工作区工具 | 基类提供 `read_file`（支持行区间）、`write_file`、`edit_file`、`delete_file`、`list_files`、`glob_files`、`grep_files`；另外提供 `append_file`、`git_log`、`git_show`、`recall_viewer`。文件修改成功后尝试提交工作区 Git，使用 Persona 署名；提交失败保留已写文件并报告错误。 |
| 主动召回 | `recall_viewer` 按来源/id 或名字查询档案；带 `query` 时返回档案首行和最多三条带时间、事件编号的旧观众原文。自动召回提供首行及有界旧发言节选；事件正文不附加身份 id。 |
| 目录列表 | 前缀将 `viewers/` 与 `handoffs/` 显示为文件计数。`list_files` 指定目录时列出全部条目；默认列表的各子目录最多展示十项并统计其余条目。前缀提示使用 `recall_viewer` 读取档案。 |
| 上下文阈值 | 批末估算 token 超过 `context.maxTokens * context.softRatio` 时，首次注入记录提醒；提醒后再次在批末超过阈值才请求交接。交接后复位提醒状态。Core 另按模型 token 上限执行强制交接。 |
| 后台整理 | 交接把快照排入串行 `dream` 队列，继续执行基类交接，不等待整理结束。基类写交接笔记并返回空 tail。后台模型由 provider 配置选择，更新观众档案、整理场次和过时内容。 |

旧发言检索由 `viewer-conversation-recall.ts` 读取 Persona 的 `.social-review/` 交流账本，
不调用模型或外部服务。按来源与账号精确隔离，中文二元词及英文词用于词法排序；
未命中时近期原文会明确标注。每次最多读取 16 页、1 MiB，每次交付最多查询三个人，
缓存最多保存 64 个身份；未读完的查询标明范围，重复查询继续旧页。原文节选最多 800 字符，
当前最多八位交流者的记忆由 `viewer-recall-context.ts` 保持合计 800 token 内，
即时上下文精简后仍保留。临近的主播台词没有观众配对凭据时不会当作成功对白。

后台整理引用 `dream.provider`，空值沿用现役 provider；模型与端点由 provider 配置决定。
`dream.onHandoff` 默认开启，决定上下文交接后是否排队深度经历总结；关闭时保留交接与交接笔记。
`sleepReview.enabled` 默认关闭；`sleepReview.eventTypes` 按行声明 World 的入睡事件类型。
入睡事件须有已确认的 `sleeping`、`world`、`gameDay` 与 `timeOfDay`；游戏时刻 12000–23999 的成功入睡提示一次睡前回顾。
同来源、世界、维度及游戏日重复入睡不再提示，去重状态跨重启保存；未知时间、白天和失败尝试不触发。
主意识通过已有发言工具自然开场。带文本的原生发言成功受理后，于批末将当前完整记录快照交后台整理；
受理不表示播完，游戏与新事件继续运行。纯动作、空文本或失败发言不会启动回顾。
后台按本日记录核对进展、收获和试错，不把跨日旧成果算成本日新事件；不需要另做上下文交接。
`dream.yieldToForeground` 启用共享 provider 的前台优先调度，等待空闲上限为
`dream.generationWaitTimeoutMs`。`planning` 提供同名两项配置；独立 provider 可分别运行。
客户端取消是否及时停止上游推理取决于服务端取消传播。

`dream.timeoutMs` 默认180秒，限制一次整理的排队、模型调用和重试退避总时长；
`dream.maxPendingTasks` 默认2，限制等待任务数，不含正在运行的一项。停机取消在途任务和等待任务。
任务结束或取消后，迟到结果不得再修改Memory或注入主意识。每次写入核对文件版本，
文件被前台更新时返回冲突，后台须重新读取并合并。实际写入后发生的失败不整段重试，已落盘内容保留。
近期状态 `sessions/_recent.md` 固定在任务开始时的版本；其他线程更新后，本次整理重新读取也不能覆写它。
这时保留现有短笺，将有证据的经历写入场次记录或带观察截止时间的结论。

`dream.maxContextTokens` 和 `dream.maxReadTokensPerRound` 为可关闭的阅读预算 fallback，默认 0。
前者包含人格、工具定义和阅读材料的 token 估算；后者限制每轮读工具交回的正文。
每轮读取预算的正值低于 128 时按 128 运行，为来源指针和继续读取游标留出空间。
启用任一项时，完整旧快照只写一次到 `sessions/archive/source-*.jsonl`；
`history-*.md` 提供观察、历史工具请求和实际回执的正文，每段带原始证据行引用。
静态前缀和协议元数据保留在原始快照中。初始材料用剩余预算优先提供近期完整正文和回执；
先依据已有材料写短笺，必要缺口通过历史正文检索、再核对对应的原始行。
分页前的读取结果与每轮已完成记录另存 `reading-*.jsonl`，相同记录只追加一次，
该文件不会追加到原始快照中。旧读取回执和初始过去材料的请求副本节选带归档文件行指针。
读工具返回 `readCursor` 时，下一轮用同一工具、原参数和游标继续首次捕获的结果；文件之后变化
不改变这份结果。新完整响应组、调用参数、写入回执与当前World事实保留；后续读入新结果需要空间时，
初始过去材料也按近期正文段节选。固定契约或当前批超预算会记录诊断。
归档失败时使用完整请求并关闭分页；Memory 原文件和执行结果保持原样。
估算不包含上游模板和分词差异，实际 prompt token 以用量账本为准。
`dream.maxOutputTokens` 控制每轮输出上限，默认 2,000；单轮写入提示随该值调整。

未启用预算 fallback 时，后台整理的转录总预算为 48,000 字符；超预算时保留少量早期背景和连续近期记录。user/assistant 单条上限
1,500 字符、工具参数 300 字符、工具回执 800 字符；忽略前缀与无文本项，上一份交接笔记不再展开。
整理结束后，非空且已变化的 `recent` 文件摘要最多注入 900 字符；非空且不为 `(nothing)` 的最终文本另注入最多 600 字符。
材料和注入结果另附旧快照观察截止、交接排队及可用的 World 事实采样时间。排队和重试保留原快照的时间；
主会话继续行动时，摘要中的状态须与较新的实际回执对账。

观众身份按来源与数字 uid 区分，昵称用于显示和查询。具名普通进场与上舰进场可按该身份召回近期旧聊天，
同名的不同账号分别检索；匿名进场只参与人数统计。进场不累计交流次数，也不触发交流建档提示。
每批进场最多读取三个身份，同一身份重复进场复用检索结果；召回仍受现有消息数与上下文预算限制。

## 即时观察与长期复盘

`toolCallRecovery.enabled` 是默认关闭、可热改的模型接口 fallback。主会话只有正文而没有原生调用，
且正文行首模仿当前可用工具的调用格式时，Persona 提示一次接口核验并允许重新选择。
连续伪调用、普通定时事件和状态快照不解除提示上限；实际原生调用或带身份的聊天、操作员新输入可解除。
引用、代码示例和不可用工具不触发；文本参数不被解析或执行，原回复与完整工具账本保留。
交接笔记和后台转录将工具行标成历史请求及回执，调用请求不能证明行动已成功。

近处玩家感知由 World 提供事实，可选快速分类由 Persona 提供注意力建议；长期复盘独立选用 provider 并读取近期活动和 Memory，不占用身体任务队列。配置、延迟边界与模型切换见 [ATTENTION.md](persona/ATTENTION.md)。

`foreground.enabled` 启用可关闭的近期上下文 fallback。即时调用保留完整环境契约和工具定义，
历史按完整模型响应及调用/回执组保留；最新输入、近期轮次、当前待办和台词不会被截断。
`action-evidence.ts` 同时提供最近八条相关请求的行动、发言、读取计数与最新行动回执节选；
仅按工具声明的 tags 分类，不推断承诺是否兑现、任务完成或身体空闲，也不自动下单或暂停。
近期台词省略演出标记并标明提交时间，历史发言不作为新的待播台本。
`foreground.maxHistoryTokens` 只限制可选历史，必留记录超预算时仍完整送达。原始 session、
事件、交接与 Memory 不改写。`expand_context` 为下一次即时调用恢复当前会话全文，随后继续
近期投影；较早会话通过工作区交接笔记按需读取。长期规划使用独立 `planning` 请求，
`planning.agendaEnabled` 可保存模型提出的灵活活动日程。主意识核验候选后用
`activity_plan` 采用、选择阶段并记录进展；日程不会自行调用World。每轮保留最多
1,200字符摘要，详细阶段和玩法按需读回；重启保留证据，迟到候选不能覆盖新进展。
见 [`ACTIVITY_AGENDA.md`](persona/ACTIVITY_AGENDA.md)。
玩法资料的 `detail` 可以只传唯一的 `activity_id`；跨主题重名时需用 `topic_key`
消歧，不根据上次展开的主题猜测。`guides` 仍需要主题编号，资料读取不代表学会或执行。
World 请托的后台构思用 `cognition.maxHistoryTokens` 选择近期材料及任务说明。
World 以 `hint.kind: 'blueprint'` 声明设计任务时，使用 `cognition.blueprintProvider`、
`cognition.blueprintMaxHistoryTokens` 和 `cognition.blueprintMaxOutputTokens` 独立选择通道与预算。
provider 名称留空继承当前通道；模型、思考强度与物理上下文容量由该 provider 配置。
普通构思和定向观察保持原通道。三项配置热改在下一份设计受理时生效，已开始的 fork 沿用绑定值。
设计 fork 让出共享 provider 的前台生成；使用独立 provider 时不占用前台 provider 的调度资源。
World 可通过 `cognition.request({ brief, blobs, hint: { context: 'task', rounds: 1 } })`
请托一次独立的定向观察。`focused-cognition` 只读取固定短人格说明、本次任务和新附件，
不继承主会话、环境长前缀或旧图片，不提供 Memory 工具；工具只来自 World 本次明确点名。
使用当前 provider，一轮模型输出最多 320 token，默认直接回答本次关注点，1–3 句、通常 80–120 个中文字。
简单有无、位置或可走性一句即可；不重复任务已有的时间、位置、尺寸和可见边界。
复杂多点只列最相关要点，详细建造设计使用蓝图构思通道或原图。45 秒超时并取消；同一时间只接受一件，忙时返回错误。
附件由 Core 保存为引用，仅在模型请求渲染时读取，主循环只收到短结论。关闭 `cognition.enabled`
也关闭该能力；失败或不支持图片时，由 World 明示后返回原始观察，不把失败当作成功分析。
World 提供完整且带观察时间的 `requestFacts` 时，用该缓存替代对应的旧状态更新；
没有完整缓存时保留同来源、同类型的增量状态链。新输入和非状态事件照常保留。
交接笔记在即时请求副本中提供带事件出处的原文节选；新自动交接的单段超过历史预算时也适用。
短的当前段、同帧聊天、回执和媒体保持原样；已经观察过的交接原文发生更正时完整保留。
全文展开请求在收到后续模型输出前保留，失败重试不会提前缩回。
实际请求在一段调用中保持原有输入前缀，只追加新事件、回执和变化后的事实。
历史增加到初次历史量加一个预算或两倍预算中的较大值时重新压缩；
前缀、覆盖的状态类型、配置变化及交接也重建。全文展开和热关闭会清除该请求缓存。
`foreground-context` 记录压缩原因、记录数和历史估算，不记录额外正文。
