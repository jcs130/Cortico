# drama-rs 原生接口

先用部署的 `DRAMA_RS_BASE` 检查 `GET /health` 与 `GET /v1/voices`，并核对所选 voice。未知音色报错，不替换为目录里的另一个音色。本机包装可能有自己的持久化和兼容端点，实际 OpenAPI 与部署记录优先于其他服务的示例。

## 单人流式合成

```http
POST {DRAMA_RS_BASE}/v1/speak
Content-Type: application/json
```

```json
{
  "text": "你好，我是可米。",
  "voice": "cormy",
  "stream": true,
  "split": false,
  "top_k": 4097,
  "max_new": 2048
}
```

这里是当前部署采用的基线，不是所有 Drama 3 服务的通用默认值。`split:false` 很重要：上游 drama-rs 的句子切分默认可能开启。整条输入发一次请求；实际长度预算按模型和服务行为核验，不能用提高网络超时消除生成长度上限。

`top_k`、`top_p`、`temperature`、`seed` 是已声明的采样字段。显式 seed 原样传递，省略时不由客户端补固定值。没有数值语速或结构化情绪参数；声音提示写在 `text` 内。不要发送兼容接口的 `input`、`model`、`response_format`、`stream_format`、`max_seconds` 或 `options.text_chunk_size` 等字段。

返回 44.1 kHz、单声道、16-bit 小端 PCM 的 WAV，流头可为未知长度。解析完整 WAV 头后就增量排播 PCM，不等整句下载；保留采样率，输出设备需要 48 kHz 时重采样。中断时关闭 HTTP 和已排队的声音，保留原始已收字节及取消记录。

原生接口没有可依赖的全文完成／截断标记：`generationComplete:null`、`generationStop:null`。字节对齐、采样率和有限 data 长度可做结构校验，开放长度 WAV 的正常 EOF 仍不能证明没有漏词。保留请求、原始 WAV、时序、错误和实际播放回执。

## 注册新音色：仅按用户明确要求

已有音色先复用。注册所需逐字稿必须与 WAV 实际内容一致，不把待合成的文本填成参考逐字稿，也不自动猜一份逐字稿。

原生注册：`POST /v1/voices?name=VOICE_ID&text=URL_ENCODED_TRANSCRIPT`，请求体为原始 WAV，`Content-Type: audio/wav`。由 URL 编码器处理名称和逐字稿，避免中文、`&`、`+` 等改变参数含义。同名注册会替换音色；更新前确认这是用户要求的目标。

部署若声明兼容接口，也可使用 multipart `POST /v1/audio/voices`，字段与该部署的 OpenAPI 一致，不把兼容端点当作所有 drama-rs 发行版自带功能。上游原版注册表为进程内状态；部署可增加持久化。不能靠一次注册成功推断重启后仍在，也不自行重启服务做验证。

## 双人场景：与可米单人直播分开

用户明确要多角色作品时，再检查该输出路径的权限与支持能力。原生上游可用 `voices:["角色A音色ID","角色B音色ID"]` 配合 `<|speaker:0|>`、`<|speaker:1|>`；本机若有已验证 `cast` 包装，按本机契约调用。服务有 cast 不代表演出扩展已开放该音色。

可米当前单人台词继续使用配置中的自身音色，不加入说话人切换。不要把上游云端 `reference_id`、多参考录音、`previous_takes`、局部编辑或导演历史字段发送给不声明它们的本机接口。
