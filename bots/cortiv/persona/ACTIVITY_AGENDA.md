Owner: CortiV Persona (`activity-agenda.ts`, `planning-review.ts`).

# 活动日程

`planning.agendaEnabled` 启用结构化后台候选。沿用已有 planning provider、间隔、
预算、超时及取消边界，不新增模型循环，不阻断前台，也不执行 World 工具。
规划材料是当前日程、采样时现场状态、长期目标、玩法目录与近期实际回执。
模型选择活动及阶段完成标准；实现只负责保存、边界检查和状态生命周期。

候选保存到 Persona Memory 的 `activity-agenda.json`。主意识先用 `activity_plan read`
核对，再 `adopt` 采用、`focus` 选择阶段；`update` 记录实际进展、完成或受阻依据。
`review` 请求同一个异步规划通道并立即返回。到期、任务受理及后台建议不代表完成。
计划允许临时交流、应急与新的选择；等待条件交给已有 `pending_work`，不占用身体队列。

每次修改已采用日程增加 revision。候选绑定采样时 revision；生成期间发生进展后，
旧候选不能覆盖新状态，需要重新规划。新候选的相同 id/title/doneWhen 保留已记录状态
与证据。重启恢复账本；已完成阶段不能通过 focus/update 重新打开。
日程没有固定活动配额、自动任务重放或由随机数选择活动的逻辑。

常驻摘要最多 1,200 字符，只提供当前阶段、够用条件、受阻条件及下一步标题。
详细计划通过 read 按需展开；玩法正文仍通过 reference_guide 渐进读取。
当前摘要在短上下文投影及交接后保留，变化时只追加新的摘要，保持已有前缀可缓存。
JSON 格式错误的候选不替换旧日程；过期、停机取消及旧 provider 的结果继续遵守
planning 既有丢弃规则。账本由工具维护，不由任意 Memory 写入工具直接修改。
