Owner: `src/core/core.ts`, `src/core/types.ts`, `src/core/loop.ts`, `src/core/bus.ts`

# src/core

Core 管理 session、事件流与模型调用的生命周期，包括事件投递、调度、上下文交接、工具执行、
容量限制、错误隔离和 Provider。Persona 定义上下文语义；Core 使用的事件封装、错误和截断记号
在 `markers.ts` 中定义。

## 文件

| 文件 | 职责 |
|---|---|
| `types.ts` | 全部契约:`Persona`、`World`、`WorldHost`、`CoreApi`、事件、工具、日志、配置类型 |
| `core.ts` | Core 装配，`Persona` / `CoreApi` 的边界 |
| `loop.ts` | 主 session 的模型调用循环、事件投递、上下文交接执行 |
| `bus.ts` | `WakeBus`：合批事件总线、四种触发模式、FIFO 顺序、暂停与投递闸门 |
| `fork.ts` | 临时 session 的工具循环 |
| `tool-outcome.ts` | Persona 对完成工具结果的同步补充，保留原日志与控制字段 |
| `session.ts`、`sessions.ts` | 常驻 session 的追加式上下文；各 session 的状态与用量记录 |
| `event-store.ts` | 按 run 分片的 JSONL 事件库,cursor 跨 run 全局单调 |
| `state.ts`、`run.ts`、`timers.ts` | `core-state.json`;run 目录;通用持久定时器 |
| `transcript.ts`、`tool-log.ts`、`usage-log.ts` | 主 session 副本、工具调用记录、用量记录 |
| `cost.ts`、`billing.ts`、`generation.ts` | 消耗汇总、计费余额、`ResponseClient` 与计量口径 |
| `prefix.ts`、`template.ts` | system 前缀装配、环境提示词三层覆盖、模板渲染 |
| `truncate.ts`、`markers.ts`、`blobs.ts` | 上下文压缩、结构记号、附件句柄(`log:` / `mem:`) |
| `config.ts`、`config-schema.ts` | `CORE_DEFAULTS`、深合并、配置项声明 |
| `instance-lock.ts`、`language.ts`、`secrets.ts` | 单实例锁、控制台语言、按名取密钥 |
| `log-context.ts`、`ipc-logger.ts`、`util.ts` | 日志关联字段、子进程日志回传、Logger 与 token 估算 |

## Core 类

构造时创建事件库、session、状态、定时器和日志，先调用 `persona.attach(core)`，再调用
`persona.declareSessions()`。声明中必须恰有一个同时设置 `receivesEvents` 和 `persistent`，否则抛错。
公开成员：`store`、`bus`、`session`、`state`、`timers`、`loop`、`llm`、`sessions`、`providers`、
`sessionDecls`;`spawnFork`、`resolveBlob` / `internBlobs`、`setWorldVisible`、`activeSpec` /
`activeProviderEntry`、`mountWorld` / `unmountWorld`、`start` / `stop`。

`WorldHost.modelFacts` 每次调用按当前端点读取。`activeProvider` 为空或端点没有模型时 `accepts`
返回 false,`activeProvider` 指向不存在的端点时抛错。

Persona 通过 `CoreApi` 访问：`injectInternal` / `injectDeferred` / `injectExternal`、
`requestContextHandoff`、`spawnFork`、`sessionInfo`、`llm`、`timers`、`deliveryGate`、
`personaState` / `savePersonaState`、`toolsTagged`、`blob`、`log`。

## 总线与唤醒

`WakeBus` 提供 `preempt`、`interrupt`、`flush`、`debounce`、`piggyback` 五种触发模式。
`preempt` 与 `interrupt` 投递后通知主循环,取消范围由主循环裁决;`promote` 把排队项改为立即触发。
debounce 的计划投递时刻为 `min(首件时刻 + maxBatchAgeMs, max(首件时刻 + minBatchAgeMs,
末件时刻 + quietGapMs))`；计数达到 `maxBatchSize` 时立即投递。
计数包含外部即时事件与候选，不包含内部事件、延迟渲染项或 piggyback 项。
piggyback 只入队，随后续唤醒一起投递。

操作者的 `paused` 和 Persona 的 `DeliveryGate` 控制投递；操作者暂停的优先级更高。
`nextBatch()` 仅支持一个消费者，每次按 FIFO 顺序取走整批。`batching` 使用共享配置引用，
更新后的值在下一次入队时参与计算。

投递水位 `lastDeliveredCursor` 持久化，队列不持久化。重启时补投水位之后的外部事件,跳过有
`core.withdrawal` 撤回记录的事件；
已被候选处理结果引用的原始归档不重复投递。内部事件仅在当次运行投递。清空分片或跳过损坏行
留下的游标空位没有可投递内容，不阻止水位推进。

## 主循环

每次唤醒处理一批事件，可进行多轮模型调用。`SessionDecl.rounds()` 提供
`{ soft, hard, softHint? }`：到 soft 轮时将 `softHint` 追加到最后一条工具回执；到 hard 轮时
记录 warn 并结束本批。`endsTurn` 工具和自然结束共用结束处理；本批结束时尚未处理的事件
退回总线，进入下一批。控制台的前缀重载与清空 session 在批次边界执行：正在处理批次时等该批
结束，空闲时立即；并发请求复用同一事务。

`preempt` 取消尚未外化的模型轮,`interrupt` 取消模型轮(已外化的输出保留)或停止 `interruptible`
工具、跳过本轮尚未开始的调用。两者取消后在同一批内接收新事件并开始下一轮,被取消的轮计入轮数,
不调用 `onTurnEnded`;到达时没有可取消的轮,事件在下一次模型请求前送入。

一批正文归档后，Core 调用 `Persona.onDelivery` 并等待它返回的 Promise,不设期限。完成前
`injectInternal` 的内容排在这批的内部行末尾、外部正文之前;完成后的注入进入总线。

模型请求经过可选的 `Persona.prepareRequest` 同步钩子。该视图只用于本轮模型调用；持久 Session、投递水位、
交接和 fork 快照保留完整记录。投影视图的上游用量记入 `lastUsage`，不作为完整 Session 的 token 计数 anchor。
轮次日志的 `requestContext` 记录完整与实际请求的条数、是否投影及估算输入量。

`ForkOptions.prepareRequest` 可按轮次生成临时请求视图，默认发送完整上下文；Core 深拷贝输入并校验记录与工具配对，
无效投影回退到完整上下文。工具执行、归档和重试沿用完整的已完成记录。

`ForkOptions.generationPriority = 'background'` 使该 fork 的模型调用让出同 provider 实例的前台批次，模型别名共享资源。
后台请求在等待中按先后顺序取用资源，前台到来时取消在途生成；已执行工具与回执保留，未提交的输出被移除，
同一轮等待前台全部模型和工具轮结束后重新生成，取消用量照常记录。不同 provider 实例各自调度。
每次资源等待默认最多 60 秒，可用 `generationWaitTimeoutMs` 指定；调用方取消或 `Core.stop()` 同时释放等待和在途请求。
未设置优先级的 fork 保留并发行为。Persona 只应把独立后台任务声明为 background，前台工具直接等待的 fork 使用默认行为。

状态 0、429 或 5xx 的模型调用失败，可保留已记录的输出和工具回执，按 `ResubmitPolicy` 重试。
默认允许连续重试 2 次、每批最多 4 次，退避为 2 秒、10 秒；上下文超限、抢占、关机或轮数
达到硬上限时不重试。

`MainLoop` 维护 `RunPhase`:`delivering`(写入一批事件,含等待 `onDelivery`)、`model`、`tools`、
`backoff`(带 `retryAt`)、`handoff`,其余时刻是 `idle`;一批的轮次结束即回到 `idle`,批末钩子在
`idle` 下运行。`running` 按开始顺序列出执行中的工具,含流式提前执行的调用。state 或 round 改变、
工具开始或结束时同步通知可见 World 的 `onRunPhase` 与控制台的订阅,异常记 warn;`getStatus().phase`
返回当前值。暂停与投递闸门不进入 `RunPhase`,由 `paused`、`scheduleBlocked` 报告。

参数不是合法 JSON 时返回 `TOOL_FAILED_BAD_ARGS`，不执行工具；未知工具返回 `UNKNOWN_TOOL`；
handler 异常转为失败回执。流式生成时 `EagerDispatch` 可提前执行完整的工具调用，遵守
`barrierAfter` 顺序，并按 call id 配对结果。回执超过 8000 字符时记录 warn。

主会话和 fork 在 handler 正常返回结果（包括失败回执）后调用可选的 `Persona.onToolOutcome`；其返回文本只追加到
上下文正文。Core 保留原工具日志、`failed`、`endsTurn` 和附件，钩子异常不影响工具结果。
未执行或没有正常返回结果的调用不保证经过该钩子。

## 上下文

`hardTokens = max(0, contextWindowOf(spec) − (spec.maxTokens ?? 0))`。
`contextWindowOf` 取 provider 探测值与手动 `contextWindow` 的较小者；两者均未知时不按窗口裁剪。
超过上限时，主循环在轮次边界结束本批，并在批末强制交接；上游报告输入超限时也请求交接。

`Persona.onHandoff(snapshot, { hardTokens })` 返回 `{ tail, trim? }`。Core 重建 system 前缀，
按 `hardTokens − estimate(prefix)` 限制保留上下文，其中 prefix 包括 system 前缀和 Persona 的合成
开头(`sessionHead()`)。Core 校验工具调用配对，并重置 session。
阶段预算与保留比例由 Persona 决定，模型配置来自当前 provider。

## 错误隔离

装配层将 World 构造失败限制在该 World。`start()` 抛错时不挂载；`stop()` 失败或超时会记录
结果并继续卸载。`onOpening`、`onDelivery`、`onBatchEnd`、`onTurnEnded`、`onIdle` 异常记录
warn；`onHandoff` 异常记录 error 并使用默认交接策略。其他钩子的异常由调用方处理。
读取 `console()` 失败时省略该 World 的环境段，继续构建前缀。主循环异常退出时记录 error
并停止定时器。启动器处理未捕获的进程异常并执行关机流程。

`instanceIsRunning(dataDir)` 只读检查实例锁对应进程是否存活，沿用锁接管时的陈旧记录判定，不获取或更改锁。
