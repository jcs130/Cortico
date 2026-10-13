<!-- Owner: src/providers/system-one/index.ts, src/providers/system-one/native.ts, src/providers/decisions.ts, src/protocol/typed-decision.ts -->
# System One 连接

模型供应商页中新建连接，选择 System One 类型，再选择本地服务或云端预设。填写服务支持的模型名，云端连接填写自己的 API Key，测试后保存。连接分别保存在部署根的 `providers/<name>/config.json` 与 `.env`；切换连接不会删除其他连接。

在 Core 配置中选择默认快决策连接 `decisionProvider`。Persona 和 World 通过可选的 `decisions.request({ state, questions }, options)` 使用它。`options.provider` 留空继承默认连接，填写已保存名称可单独覆盖。地址、认证和模型由宿主 provider 解析，不传入游戏引擎、提示词或方法库。

本地默认地址为 `http://127.0.0.1:8090/v1`；云端预设为 `https://api.typesafe.ai/v1`、模型别名 `jev-latest`，接口路径默认 `/systemone`。原生协议及模型别名见 [TypeSafe API](https://docs.typesafe.ai/api)。现有应用使用 `choice`：请求包含 `state`、`questions` 和 `model`，响应必须覆盖全部问题和候选，带合法概率分布与置信度。普通 Chat Completions 服务不能直接代替该接口。

每个独立无历史决策有自己的请求关联 ID；统计只含模型、耗时、终态及服务实际返回的 token。未知用量为 `null`。HTTP 往返耗时不当作模型执行耗时。连接切换、调用取消、World 卸载或超过等待上限后，迟到建议不可采用；实际世界是否仍适用由调用方再次核验。类型 API 当前仅支持 choice，未提供 noul 或 score。

默认快决策连接未配置时返回不可用，不启动主模型代替。现有调用方保留规则或既有上下文决策。云端等待上限由调用方设置，需同时核对其现场有效期。
