# 创作拆分后的云服务

图片、视频和歌曲生成由独立 cortico-world-aigc 配置和统计。TTS 与动作执行仍由演出室负责。成品从素材句柄导入并预览、采用、播放，详见 [music.md](music.md)。

# 不部署推理模型的使用方式

普通电脑可以运行这个 World。人物渲染、口型和基础手势是客户端动画；只有语音、创作新歌、生成新动作才需要对应的推理服务。每项独立配置，不必一起安装。

| 能力                       | 无本地推理模型的路径                                      | 本版情况                                                           |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| 表情、姿态、挥手、内置动作 | 宿主 LLM 直接选择语义动作，由浏览器执行                   | 已实现；不需要动作模型                                             |
| TTS                        | OpenAI 风格 `POST /v1/audio/speech`，直接云服务或 LiteLLM | 实现并以本地模拟 24kHz 云 WAV 和实际 LAN 48kHz 流验证              |
| 新歌/纯器乐                | 独立 AIGC World 的显式音乐服务                            | 演出室只导入成品、试听和采用；付费账号实调尚未做                   |
| 新身体动作                 | 远程 HTTPS 中立动作网关，GPU 放在远端                     | 已实现鉴权与协议调用；不是任意三维服务的自动骨骼适配器             |
| 已有音乐与动作             | 本地文件/已下载资产                                       | 不调用模型，不产生云推理请求                                       |

## 快速配置

参考 [examples/cloud-stage.json](../examples/cloud-stage.json)，安装一个人物后把 avatars 数组填好，再设置自己的密钥环境变量并启动。该示例不带可米声音或私人资产，不会自动创建云资源。只有显式调用工具才提交新生成任务。

TTS 支持 8–96kHz 单声道 PCM16 WAV，WebAudio 使用文件真实采样率，保持 480ms 音频预缓冲；不会把 24kHz 当 48kHz 导致变声。`voicesUrl` 和 `metricsUrl` 都是可选网关扩展，普通云端不必提供。`voice.instructions` 可传服务商支持的语气说明；未配置时不发送。云端预设声音与可米的私人克隆音色是不同资产。

## 云音乐成品

在 cortico-world-aigc 中配置音乐模型，由宿主调用 aigc_create 生成和查询；拿到已归档的音频句柄后调用 avatar_music 的 import，再 review → preview → approve/reject。歌曲生成任务的受理与完成、作品的采用和实际播放分别记录。两个 World 互不调用内部对象。

演出室不会执行旧 music.cloud 或 music.generationUrl 的生成请求；旧作业与本地音频仍可查询，运行中的旧任务需按原服务请求编号人工对账，不自动重投。迁移配置和新任务管理见 AIGC World 文档。

导入只接收宿主已解析的 WAV 字节，先检查容器、时长和 SHA256，保持候选状态。试听在拥有音频的控制页面进行，OBS 页面不播放候选；语音和试听共用一个音频出口。采用后才进入正式曲库，仍须另行 play。WAV 检查不等于核实歌词、完整性或纯器乐无人声；缺少人声轨/时间戳时口型来源为 none。

## 远程动作

每个人物可配置：

```json
{
  "motion": {
    "url": "https://motion.example.com/api/avatar-one",
    "tokenEnv": "AVATAR_MOTION_API_KEY"
  }
}
```

它遵循同一 `health/jobs/clips/review/used` 网关协议，保留 URL 路径前缀，凭据仅用于服务端请求。旧 motionUrl 仍兼容。下载片段须匹配目标人物 SHA256，继续区分候选与采用。远程 worker 可以由部署者集中维护；使用者无需本机 CUDA/Python 权重。

DeepMotion SayMotion 确有文本到三维 API 和自定义人物，但官方说明 API 需要合作伙伴资格；本版没有把它标为开箱即用。不同服务返回的 FBX/GLB/BVH 仍需要骨骼重定向和单独验收，视频生成接口也不能当作骨骼动画接口。

## 已核实的服务可用性

截至 2026-10-20，MiniMax 官方文档列有 Music 3.0，但同时说明自 2026-08-20 起新用户不再开通官方音乐付费 API，旧付费用户可继续使用。因此新用户示例采用 fal 当前列出的托管接口；不根据模型名推断用户拥有权限或余额。

目前没有进行付费云音乐调用，实际额度、延迟和生成质量应由使用者的账号另行验收。实际 LAN TTS 的回执也不作为某家公有云已测试的证据。

官方资料：[OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech)、[fal Music 2.6](https://fal.ai/models/fal-ai/minimax-music/v2.6/api)、[fal 队列](https://fal.ai/docs/documentation/model-apis/inference/queue)、[MiniMax API 与账号限制](https://platform.minimax.io/docs/api-reference/music-generation)、[SayMotion API](https://www.deepmotion.com/saymotion-api)。
