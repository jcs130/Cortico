# 语音文本编写

先读 `avatar_query {"action":"voice"}` 或 `avatar_voice {"action":"status"}` 的 `textFormat` 和 `writingGuide`。语音格式属于所选服务，不根据角色或模型名称猜测。`plain` 只写自然口语。

在 World 配置的“语音文本”中选择后端实际采用的格式。该值在服务启动时读取；重启后核对语音状态，不以配置文件保存作为已生效证据。自动解说的起草与解析采用同一个当前契约；Drama3 的方括号声音指令保留到合成输入，近期台词与重复判断使用去除指令的正文。

## Drama3

当 `textFormat` 为 `drama-3`：正文就是给观众说的话；可在需要改变说法的地方放简短方括号指令，例如 `[warm, cheerful]`、`[轻声，带一点惊喜]`。指令描述声音、情绪、语速或说话对象。指令可与台词用不同语言，并非固定枚举。自然标点优先；无需每句都加标签。

示例：`大家晚上好！[warm, cheerful] 我是小晴，今天继续沿着这条小路旅行。`

音效如 `[small laugh]`、`[sighs]` 或 `[pause]` 放在实际发生处。云端官方文档还支持 `<whisper>…</whisper>`、`<emphasis>…</emphasis>` 等成对标签及多发言人；本地移植版本应先用真实样本验证，再采用，不能把云端能力等同于本地已验证能力。

### 当前本地移植的使用经验

来源：audio.cpp `fish_drama3` 模型指南（2026-10-21），以及本地 Drama3 Q4 试验。部分非语言事件或强情绪提示可能拖长、丢失台词或达到生成上限。首次采用一种新提示，先用短台词试听；出现不完整回执就修订原请求，不无证据重发。

直播优先一到三句自然口语，约 25–100 个汉字是起始建议，不是硬性拒绝规则。简短语气标签可以省略。避免以连续叹气/笑声等非语言事件开头；先说一小句，再给声音指令。单角色克隆只用已配置音色，不输出“角色名：”、说话人切换或多角色对话标记。参考音频描述的是参考音频内容，不写成台词。

身体动作、镜头、表情不是 TTS 指令：使用 `avatar_control`，并可在同一轮与语音分别调用。标签不会自动证明表情或动作已播放。受理、收到音频、实际起声、播放结束分别看原 actionId 的执行证据。

模型需先预热再接直播；冷启动时间不当作正常首声延迟。禁止靠重复说话、编造游戏进度或不停报状态填补冷场。

官方资料：
- https://docs.fish.audio/features/text-to-speech/drama-3
- https://github.com/JarodMica/audio.cpp/blob/drama-3-native/docs/models/fish_drama3.md
- https://sgl-project.github.io/sglang-omni/cookbook/fishaudio_drama3.html
