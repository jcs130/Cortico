# src/core/model-observer.ts / 模型与 World 元数据观察

Core 包装主循环、绑定客户端和 fork 的模型请求，向可选的 `Persona.onModelObservation` 发布开始与结束元数据。开始事件包含匿名请求身份、通道、模型、thinking/effort 和完整输入估算。结束事件包含调用尝试的终态、上游请求身份、实测 token 与单独报告的执行时间。观察器异常不改变请求或事件投递。

模型传输在普通响应和流式最终 usage 中读取 `inference_stats`。HTTP 请求身份不匹配时丢弃该统计快照；同一尝试以最后一份快照覆盖。显式 null 保持未知，不从网关往返耗时或输入、生成阶段之和推算执行时间。流式客户端继续读取 finish_reason 之后的 usage 帧。

`x-litellm-session-id` 使用运行身份与会话身份的 SHA256 派生值，同一会话内稳定。它只用于上游会话分组，不能代替某次请求身份。Core 的重提请求和传输层 attempt 分别记录，取消与丢弃保留原终态。

World 事件落库后，可选的 `Persona.onWorldMetadata` 同步取得来源、事件类型、时间及 metadata，包括仅归档的事件。观察器没有正文或附件。World 可以发布空正文、deliver:false 的验证元数据，既不唤醒模型，也不增加模型上下文。metadata 的语义和聚合由 Persona 与对应 World 定义。

`CoreApi.runtimeMetadata` 返回缓存的阶段、暂停状态、主连接身份和框架输入硬限；读取不调用模型。上下文估算、框架硬限和引擎有效窗口分别报告。
