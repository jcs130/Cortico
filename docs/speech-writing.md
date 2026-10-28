# 语音文本编写

先读 `avatar_query {"action":"voice"}` 或 `avatar_voice {"action":"status"}` 的 `textFormat` 和 `writingGuide`。语音格式属于所选服务，不根据角色或模型名称猜测。`plain` 只写自然口语。

在 World 配置的“语音文本”中选择后端实际采用的格式。该值在服务启动时读取；重启后核对语音状态，不以配置文件保存作为已生效证据。自动解说的起草与解析采用同一个当前契约；Drama3 的方括号声音指令保留到合成输入，近期台词与重复判断使用去除指令的正文。

## Drama3

### 分句与名字

服务支持原生 PCM SSE 时，优先使用 `voice.synthesisTransport="pcm-sse"`，并配置实测的 `pcmSampleRate`、关闭客户端 `segmentMaxChars`。一条台词使用一次后端生成上下文，PCM 随到随播；不要将多次独立克隆当作同一条流式生成。后端种子等参数写在显式 `extraBody`，采用前验证服务实际回报，固定种子本身不等于跨文本音色已经一致。

原生终态的 `stop` 必须为 `complete` 且样本数匹配，才记录合成完成。`max_seconds` 等生成截断不是播放完成；保留失败及恢复提示，不隐藏、不无证据重复。提高网络超时不会消除生成长度上限。长台词需后端提供保留声学上下文的分块或更合适的生成预算，不能靠客户端反复独立克隆掩盖问题。

短句合成按自然分句、完整词和配置的名字分段。不要让 LLM 自行数字符，也不要在名字后附“读作……”等会被念出的说明。多个很短的句子可在一个请求内合成，避免每个句号都重新生成音色和语气。`voice.pronunciations` 可配置名字到自然口语读法的映射；仅在 TTS 出口使用，显示、聊天和记忆保留原名。相同映射可只保护名字完整。先试听实际音色，不把 HTTP 200 当作发音正确。

Fish 官方 Drama3 支持 `<|phoneme_start|>…<|phoneme_end|>`：英文采用 CMU Arpabet，中文采用逐音节带声调数字的拼音。这是官方能力说明，不能据此认定任意 audio.cpp 网关都正确实现。未验证的服务使用自然口语，不自动塞音素、角色前缀、语言切换或情绪标记。音色身份由所选 voice 及其参考音频决定，说话人切换不能用来修复名字读音。

当 `textFormat` 为 `drama-3`：正文就是给观众说的话；可在需要改变说法的地方放简短方括号指令，例如 `[warm, cheerful]`、`[轻声，带一点惊喜]`。指令描述声音、情绪、语速或说话对象。指令可与台词用不同语言，并非固定枚举。自然标点优先；无需每句都加标签。

示例：`大家晚上好！[warm, cheerful] 我是小晴，今天继续沿着这条小路旅行。`

音效如 `[small laugh]`、`[sighs]` 或 `[pause]` 放在实际发生处。云端官方文档还支持 `<whisper>…</whisper>`、`<emphasis>…</emphasis>` 等成对标签及多发言人；本地移植版本应先用真实样本验证，再采用，不能把云端能力等同于本地已验证能力。

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
