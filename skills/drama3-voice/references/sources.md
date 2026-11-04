# 资料与证据边界

核对日期：2026-10-29。示例是编写建议，不是每种音色的效果保证。

| 来源 | 用途与边界 |
| --- | --- |
| [Fish Audio Drama 3 指南](https://docs.fish.audio/features/text-to-speech/drama-3) | 自然语言演绎、方括号事件、配对标签。云端 API 的参数不能直接移植到本机。 |
| [模型卡](https://huggingface.co/fishaudio/drama-3) | 原生模型的点状标签和多角色能力；不表示某个推理移植已开放所有能力。 |
| [中文音素](https://docs.fish.audio/developer-guide/core-features/fine-grained-control/chinese)／[英文音素](https://docs.fish.audio/developer-guide/core-features/fine-grained-control/english) | 中文逐音节声调拼音、英文 CMU Arpabet；是否能经过本地文本处理仍须验证。 |
| [drama-rs README](https://github.com/apiplant/drama-rs/blob/498f18c0b403006f207db121df8c70e024b2453a/README.md) | 原生请求、句子切分与内联提示的传递。 |
| [drama-rs 服务实现](https://github.com/apiplant/drama-rs/blob/498f18c0b403006f207db121df8c70e024b2453a/src/serve.rs)／[OpenAPI](https://github.com/apiplant/drama-rs/blob/498f18c0b403006f207db121df8c70e024b2453a/src/openapi.json) | 已声明字段、未知长度 WAV、音色解析与原版注册表行为。没有可靠全文 complete／截断终态。 |

区分“官方描述了能力”“接口接受并传递标记”“实际听起来有效”“已在当前直播设备播放”。只有相应证据才能升级结论；不把上游性能数字当作本机延迟。

本机音色列表、持久化、参考和 GGUF 哈希属于具体部署证据。使用该部署的验收记录或维护者报告，并写明来源；本机 HTTP 接口没有返回的哈希不能声称由客户端重新核验。
