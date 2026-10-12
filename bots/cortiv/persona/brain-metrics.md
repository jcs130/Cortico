# brain-metrics.ts / 请求策略与目标验证统计

只读接口是 `GET /api/console/providers/persona:cortiv/panels/planning/metrics`，schema 为 `cortico-brain-metrics-v1`。接口读取内存事件缓存，不运行选择器、模型或工具，也不读取用量账本和会话正文。

每次真实提交记录通道、模型、阅读建议及实际 epoch 预算、思考建议及实际 thinking/effort。当前 epoch 沿用时标明继承；请求预算和应用预算分别保留。模型路由目前来自通道配置，不能标为自主换模型。端点没有确认参数生效或独立思考预算时，对应字段保持 null。

窗口固定600秒，重启后报告部分覆盖。提交按匿名逻辑请求去重，传输尝试按 attempt 去重，token 用量再按上游请求身份去重。系统1分类尝试使用独立身份，复用建议和冷却不新增尝试。Core 重提与传输层额外尝试均计入 retries；calls 只统计已结束尝试。某一 token 项存在未知样本时，其窗口总量为 null，并报告 usage_samples。

历史预算与已关联完整输入按 nearest-rank 报告 P50/P95、样本数。估算输入不替换实测输入。开始新请求时不会复制上一请求缺失的字段。元数据缓存有数量上限，溢出后将窗口完整性标为 false。

目标验证接收 World 的 `task-verification-v1` 元数据。环境验证终态须带稳定 task_id、evidence_id 和 verified_by=environment。日程的 done 只记录待验证，撤销与工具受理不计成功。千灯纪以登记目标为单位发布机械结案回执；这些登记项尚不保证与日程或用户原始任务一一对应。

恢复率需要原目标、失败案例、策略变更及验证结案的关联，缺少关联时保持未知。不能用换一个工具、重复点击或新的模型请求自动判定原目标已恢复。记录不包含目标正文、提示、回答、思考或凭据。
