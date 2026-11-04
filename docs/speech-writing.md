# 语音文本编写

Drama 3 的可复用技能入口为 [drama3-voice/SKILL.md](../skills/drama3-voice/SKILL.md)：短入口包含台词与发声决策，写作、原生接口与资料按需展开。普通输出不需要载入全部参考。

先读 `avatar_query {"action":"voice"}` 或 `avatar_voice {"action":"status"}` 的 `textFormat` 和 `writingGuide`。语音格式属于所选服务，不根据角色或模型名称猜测。`plain` 只写自然口语。

在 World 配置的“语音文本”中选择后端实际采用的格式。该值在服务启动时读取；重启后核对语音状态，不以配置文件保存作为已生效证据。自动解说的起草与解析采用同一个当前契约；Drama3 的方括号声音指令保留到合成输入，近期台词与重复判断使用去除指令的正文。

## Drama3

### drama-rs 原生接口

配置 `voice.synthesisTransport="drama-rs-wav"`，`voice.url="http://服务地址/v1/speak"`，`voice.voice` 为已注册音色，`segmentMaxChars:0`、`requireWavCompletion:false`。启动先检查同一服务的 `/health` 和 `/v1/voices`；原生音色列表是唯一有效目录，配置或已保存选择中的未知音色直接报错，不回退。不要重新注册既有参考音色。

每条完整台词只发送一次 `{text,voice,stream:true,split:false,top_k:4097,max_new:2048}`。`extraBody` 可设置 `top_k`、`max_new`、服务文档支持的 `top_p`／`temperature` 和明确的实验 `seed`；也可在单次 `avatar_voice speak` 显式传 `seed`，零值同样保留。日常合成不固定种子，不沿用兼容接口的 `model`、`input`、`max_seconds`、SSE 或其他控制字段。

上游返回 44,100 Hz、单声道、PCM16 WAV。客户端按收到的 WAV 头和 PCM 增量播放，不等待整条下载；AudioBuffer 保持真实的 44.1 kHz，输出设备为 48 kHz 时由 Web Audio 转换，不改采样率标签冒充调速。播放中断会关闭上游 HTTP 和已经排队的声音。

当前原生 API 没有可靠的 complete／截断终态。即使 HTTP 200、WAV 字节结构有效并读到 EOF，`generationComplete` 和 `generationStop` 仍为 `null`；`transport-complete` 仅表示传输结束，实际 `playing`／`ended` 只证明播放。原始 WAV、完整请求 JSON、SHA256 与传输／失败记录保存在演出数据目录的 `native-wav`。短句、204 字长句、名字与负数坐标须试听，不能用字节数或 HTTP 成功代替全文与音色验收。

### PCM SSE 兼容接口与名字

服务支持原生 PCM SSE 时，优先使用 `voice.synthesisTransport="pcm-sse"`，并配置实测的 `pcmSampleRate`、将客户端 `segmentMaxChars` 设为 `0`。一条完整台词只发一次请求，PCM 随到随播，不用多次独立克隆拼接。当前原生 Drama 3 服务输出 44,100 Hz、PCM16、小端、单声道，使用 `response_format:"pcm",stream_format:"sse"`。`extraBody` 配置 `{max_seconds:30,top_k:4097}`：`max_seconds` 是每个引擎内部块的预算，整句可以超过 30 秒。不要传 `options.text_chunk_size`、`text_chunk_mode` 或 `single_chunk`。

`top_k`、`top_p`、`temperature`、`seed` 可用于明确的实验和复现；不要为了固定音色给全部直播台词设同一个种子。修改采样参数前先用同一台词试听对照。语速没有可靠的数值 API，不发送 `speed`、`rate` 或 `tempo`，也不改采样率冒充调速；用自然台词和标点引导节奏，不能承诺精确倍率。

原生终态的 `stop` 必须为 `complete` 且 `samples` 与实际 PCM 字节数匹配，才记录合成完成。`max_seconds`、`model_limit`、`error`、缺失终态及断线均算失败，停止已排队的音频并关闭请求，不能把半句记为成功。WAV 兼容路径同样检查 `X-Speech-Stop`，不能只看 HTTP 200；当前服务应启用 `requireWavCompletion:true`。保留失败及恢复提示，不隐藏、不自动独立重合成已播片段。提高网络超时不会消除生成长度上限。

保留自然标点和完整名字；不要让 LLM 自行数字符，也不要在名字后附“读作……”等会被念出的说明。`voice.pronunciations` 可配置名字到自然口语读法的映射；仅在 TTS 出口使用，显示、聊天和记忆保留原名。相同映射保留名字原样。先试听实际音色，不把 HTTP 200 当作发音正确。

Fish 官方 Drama3 支持 `<|phoneme_start|>…<|phoneme_end|>`：英文采用 CMU Arpabet，中文采用逐音节带声调数字的拼音。这是官方能力说明，不能据此认定任意 audio.cpp 网关都正确实现。未验证的服务使用自然口语，不自动塞音素、角色前缀、语言切换或情绪标记。音色身份由所选 voice 及其参考音频决定，说话人切换不能用来修复名字读音。

当 `textFormat` 为 `drama-3`：正文就是给观众说的话。正常单人发言优先自然口语，不加说话人标签；仅在剧情确实需要时少量使用服务已支持的 `[whispers]`、`[laughs]`，逐句试听，避免过多提示导致音色改变。只有所选音色为 `cast` 的双人场景，才按服务约定使用 `<|speaker:0|>`、`<|speaker:1|>`。

当前接口没有开放多参考录音、多轮导演修订或局部音频编辑；不要根据上游论文或云端能力向此接口添加这些字段。保留已注册音色及原参考文件，不为调整台词重注册。

### 当前本地移植的使用经验

来源：audio.cpp `fish_drama3` 模型指南（2026-10-21），以及本地 Drama3 Q4 试验。部分非语言事件或强情绪提示可能拖长、丢失台词或达到生成上限。首次采用一种新提示，先用短台词试听；出现不完整回执就修订原请求，不无证据重发。

直播优先一到三句自然口语，约 25–100 个汉字是起始建议，不是硬性拒绝规则。简短语气标签可以省略。避免以连续叹气/笑声等非语言事件开头；先说一小句，再给声音指令。单角色克隆只用已配置音色，不输出“角色名：”、说话人切换或多角色对话标记。参考音频描述的是参考音频内容，不写成台词。

身体动作、镜头、表情不是 TTS 指令：使用 `avatar_control`，并可在同一轮与语音分别调用。标签不会自动证明表情或动作已播放。受理、收到音频、实际起声、播放结束分别看原 actionId 的执行证据。

模型需先预热再接直播；冷启动时间不当作正常首声延迟。禁止靠重复说话、编造游戏进度或不停报状态填补冷场。

官方资料：
- https://docs.fish.audio/developer-guide/core-features/fine-grained-control/english
- https://docs.fish.audio/developer-guide/core-features/fine-grained-control/chinese
- https://docs.fish.audio/features/text-to-speech/drama-3
- https://github.com/JarodMica/audio.cpp/blob/drama-3-native/docs/models/fish_drama3.md
- https://sgl-project.github.io/sglang-omni/cookbook/fishaudio_drama3.html
