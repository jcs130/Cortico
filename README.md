<!-- Owner: src/index.ts, src/core/stage.ts, src/desktop-audio.ts, src/core/speech-performance.ts -->

# 3D 演出室 · Avatar Stage

普通对话、问候与创作口播不要求观察时间。描述当前现场事实时，`avatar_voice speak` 的 `observed_at` 直接复制来源事件或采样的 ISO 8601 时间（含时区），也兼容来源已有的 Unix 秒数。显式提供的过期、未来、无时区或无效日期仍被拒绝，不会自动换成当前时间。`speechObservationMaxAgeSeconds` 控制这类来源时间的有效期；0 使用 15 秒。空闲解说继续携带所引用事件的最早原始时间。

`voice.busyPolicy:"preserve"` 保留当前合成或播放中的一句，新台词返回 `accepted:false, reason:audio_busy`，不合成、不排队、不打断；下次只讲仍有价值的新内容。显式 `avatar_voice interrupt` 仍可打断。省略该配置时沿用 `replace` 行为。此能力适用于所有游戏和其他实时演出。

## 短句合成 / Sentence synthesis

`voice.segmentMaxChars` 可选启用短句合成（8–160 个可发音字符）。按标点、完整词与已配置名字分段，合并过短句子，不在固定字符位置截断。说话人归属在续段保留，点状声音指令不自动重复。每次仅有一个合成 HTTP 请求；取消旧请求后等待它结束，再发送下一条。服务必须返回采样率一致的单声道 PCM16 WAV。每句返回后立即转发 PCM，使用一个 WAV 流封装，不把多个 RIFF 文件直接串起来，也不等待整段台词合成完毕。

`voice.pronunciations` 是可选的名字→自然口语读法词典。只在最终合成请求应用，不改变原台词、气泡或聊天记录。相同读法也可用于保护中文名字不被切开；不接受未验证的音素、SSML 或说话人标记。默认空词典，不内置角色或服务器特例。

后端支持时使用 `voice.synthesisTransport: "pcm-sse"` 和经过实测的 `voice.pcmSampleRate`。关闭客户端分段，一条台词发一个请求，原生 PCM SSE 转为同一个 WAV 流供现有播放器消费；首段音频不等待整个合成完成。后端 `stop: complete` 与样本数都核实后才记合成完成，生成上限、缺失终态或音频损坏均保留为失败，并停止已排队的音频。`top_k`、`top_p`、`temperature`、`seed` 仅按服务实际契约在 `extraBody` 显式配置；不默认给每条直播台词设置同一个种子。

`voice.extraBody` 传入后端实际支持的 JSON 参数，例如原生 Drama 3 连续生成服务使用 `{max_seconds:30,top_k:4097}`。此服务的 `max_seconds` 是每个引擎内部块的预算，整条语音可以超过 30 秒；客户端不发送 `options.text_chunk_size`、`text_chunk_mode` 或 `single_chunk`。模型、台词、音色和所选音频传输由当前配置决定，附加参数不能覆盖。`voice.writingGuides` 按音色 ID 提供实际文本契约，通过语音状态按需读取。未配置分句时保留原有单次合成行为。

一条台词仍只有原来的 actionId；合成结束不产生播放完成证据，继续采用客户端 playing/ended 回执。说话人音色必须在后端真实注册，不会自动替换为其他音色。

## 现场反应与桌面回复 / Scene reactions and desktop replies

`director.reactionSources` 可选指定现场事件来源，系统一从去重后的已安装动作中选择无声反应。请求只含两条带来源的新事实和当前台词；手动操作、音频占用或版本变化会取消过期候选。形象词表的 `presentation:{key,auto,tags}` 保留作者允许自动选用的范围，手动动作仍完整可用。反应提交、首个渲染帧与动作结束分别留证。

`replySpeech:{enabled:true,sources:"desktop-pet"}` 通过原语音队列朗读桌面工具产生的纯台词。来源必须明确标记 `via:"tool"`，演出转发和活动日志不会再次朗读。桌面自己的 TTS 可以保持关闭；语音仍由本 World 配置的服务合成，音频拥有者负责播放。此模式要求桌宠支持成品音频的 `showText:false`，保留原气泡并避免重复显示。

The optional source list drives silent, source-bound reactions through the host decision port. Version changes and manual control discard stale choices. `replySpeech` reuses the stage speech queue for literal desktop replies; it does not generate another answer or select a different voice. The renderer's played/ended receipts remain separate from admission.

## 桌宠音频输出 / Desktop audio output

`presentation: {mode:"desktop-audio",url:"http://127.0.0.1:18446"}` 复用现有 `avatar_voice` 和 `avatar_music`，通过桌宠的 `desktop-media/v1` 播放分块语音和成品歌曲。桌宠需开启 `media.enabled` 和声音。TTS 地址、音色、凭据、曲库、试听采用和 AIGC 成品句柄仍使用本 World 的原配置；该接入不包含人物或服务商默认配置。桌宠配置 media.rendererDir 指向本包 renderer/desktop-player.js 所在目录后，语音边接收 PCM 边播放，口型和歌词跟随真实音频时钟。media.presentationOnly:true 让声音和手动形象控制统一由本扩展负责，桌宠保留输入、显示和移动执行。只使用人声包络或时间戳歌词作为演唱口型；没有这些证据时不驱动嘴巴。

The optional desktop audio device uses the existing stage queue, song library, speech backend and single output lease. It streams PCM WAV speech to the Stage-owned desktop player; songs remain finished assets. It reconciles actual playing/ended receipts against the original stage action ID. It registers as `audio-only`: these receipts cannot confirm body or avatar rendering. The host decision port chooses expressions and gestures from the current desktop vocabulary. `avatar_control` reads the displayed figure's actual vocabulary and handles expressions, motions, movement and cancellation through that same surface. Bilibili audience events continue through the separate Bilibili World and the host Persona.

Text-only `desktop-text` remains available. Explicit audio mode requires both extensions to support the media protocol; an unavailable or muted device does not claim playback. A cancelled upload cannot begin later. Stage/desktop stop and disconnect release the current output. No paid fallback service or synthesis model is started by mounting the adapter.

## 桌宠文字与动作 / Desktop text and actions

`presentation: { mode: "desktop-text", url: "http://127.0.0.1:18446" }` 显式将本 World 的 `avatar_voice` 和可选游戏解说送入桌宠文字演出接口。此模式不调用 TTS；原 `stage` 模式保持默认。桌宠需要支持 `desktop-presentation/v1`，并实际连接可见的形象。解说继续使用宿主认知接口、来源白名单、证据编号与空闲版本检查；系统一只从当前桌宠词表选择表情和动作。入队不等于显示，显示回执保存在桌宠的 `desktop-pet.presentation` 记录中。缺少桌宠或接口版本不兼容时返回明确错误，不回退到语音。

The explicit `desktop-text` output sends dialogue and optional evidence-based commentary to the local pet renderer without TTS. The existing host decision port selects installed expressions and motions. This does not control game bodies or share game state. Query `avatar_voice status` for the active output and writing contract, and the pet's `GET /api/presentation` for actual queue/display receipts. Default output remains `stage`.

avatar_query 提供只读状态、动作回执、音色和曲库查询；运行状态通过事件和查询传递，系统前缀保持稳定。Bot 装配应为每个播出通道选择一个 TTS／音乐出口；本 World 的音频拥有者不覆盖其他演出 World。

独立的 Cortico World：让宿主 LLM 选择三维人物的动作、表情、语音和歌曲。保留原 VTuber World，按需切换。游戏连接、人格、长期记忆和任务规划由宿主负责。

## 已实现

### 部署自己的渲染适配

源码 `web/index.html` 的 `avatar-renderer-profiles` JSON 块默认为空。构建后的播出文件位于 `dist/web/index.html`；部署私有配置时编辑这个产物，升级后重新安装私有块。部署者可按人物 SHA256 安装自己的 ES module（`data:text/javascript;base64,`），导出 `createPresentation({ model, animations, mixer, THREE, vrm, avatar })`。`vrm` 为加载后的 VRM 实例，普通 glTF 时为 `null`；`avatar` 为该人物的公开清单。只在哈希匹配时加载；公共包不包含人物代码或素材。

异步人物适配和纹理初始化完成后，模型才交给逐帧更新；加载中替换人物不会把过期适配器交给新模型。适配器可返回 `getBoneNode(semantic)`，供身体控制与画面证据采用它实际驱动的骨骼；未提供时仍使用标准 VRM 规范化骨架或清单中的 glTF 骨名。能力目录包含模型实际提供的手指、双眼和下颌骨位，以及自定义 VRM 表情；缺少的骨位不宣称可用。

适配器可提供 `ready`、`gesture`、`prepareClip`、`play`、`finish`、`frame` 和 `dispose`。它负责已注册人物的朝向、材质、眼部/口型、骨骼轴和动画混合，不拥有模型决策、语音播放或 World 事件。`frame` 自行推进传入的 mixer；播放回执仍由演出室统一管理。`gesture` 可将语义动作映射到已安装动画的原名，未映射的动作保持原控制契约。切换人物时销毁旧适配器。

私有适配应保存为部署产物，在升级包后重新安装；只刷新演出页面即可加载浏览器文件。不要把人物代码写进共享 viewer 或从人物 GLB 自动执行代码。

### 标准 VRM 动作库

桌宠等浏览器适配器可以导入 `cortico-world-avatar-stage/renderer/vrm-motion.js` 的 `VRMMotionLayer` 和 `cortico-world-avatar-stage/renderer/expression-weights.js` 的 `expressionWeights`，复用同一套标准 VRMA、动作混合与表情实现。两个模块不启动 World、语音服务或演出网页；适配器负责音频时钟、口型采样和自己的画布生命周期。

标准人物可以直接使用 VRMA 动画，无需人物专用渲染器。部署时在 `dist/web/index.html` 的 `avatar-motion-presets` JSON 块按人物 SHA256 安装数据索引：

```json
{
  "人物文件的SHA256": {
    "idle": "idle",
    "gestures": { "wave": "wave", "nod": "nod", "cheer": "greeting" },
    "clips": {
      "idle": { "url": "data:model/gltf-binary;base64,...", "sha256": "动画文件的SHA256" }
    }
  }
}
```

索引中引用的动作都必须在 `clips` 声明。文件需为 `VRMC_vrm_animation` 1.0，按哈希校验，再由官方 three-vrm-animation 适配标准骨架。待机循环播放，手势进出各用约 0.4 秒过渡；UniMate 的原始骨骼动作播放时暂停规范化动画，结束后恢复。动作索引只包含数据；私人动作文件不进入公共包。该渲染映射不更改 World 既有语义手势工具或把全部动画宣称为 Agent 已学会。

`frame` 的状态含 `speech`：只有浏览器音频时钟已开始播放时，才提供 `{ actionId }`，结束或取消后为 `null`。它用于将已准备的表情与正在播放的语音对应；适配器仍不拥有音频或模型决策。音频统计也附带同一个 `actionId`，`firstPlaybackMs` 从发起音频 HTTP 请求开始计算，包含服务等待和预缓冲。

| 能力                                   | 接口             | 没有外部模型时                   |
| -------------------------------------- | ---------------- | -------------------------------- |
| 人物、表情、骨骼姿态、挥手/点头/鞠躬等 | `avatar_control` | 直接执行，支持模型内置动画       |
| 可复用动作库、UniMate 文本生成动作     | `avatar_motion`  | 继续用直接姿态、手势和已安装动画 |
| TTS、口型、音色选择、打断              | `avatar_voice`   | 返回未配置，不启动本地替代引擎   |
| 成品歌曲导入、试听、采用、播放及演唱口型  | `avatar_music`   | 播放已安装曲目，不启动生成模型   |

TTS 是这个 World 的能力。它使用显式配置的 LiteLLM/OpenAI 风格 WAV 接口：480ms 音频预缓冲、边接收边播放；打断同时关闭旧 HTTP 请求和清空已排程音频。语音和歌曲共用一个前景音频出口，多个浏览器页面不会同时出声。

动作模型输出不是角色动画质量保证。生成、数值检查、预览、采用和真实播出分别记录。UniMate 只生成身体动作，表情、口型、手指及毛发/衣服的次级运动分别处理。

### 可选游戏解说

`commentary` 默认关闭。启用后，有新鲜游戏或观众事件时，通过宿主 `WorldHost.cognition.request` 起草一两句候选；游戏主线程继续行动。确认语音正在播放时，可提前准备下一句，最多保留一个候选，等配置的空闲间隔再提交；不预先排队或合成多句音频。没有新内容可以跳过。它不创建另一个角色、模型连接、身体任务或长期记忆库。

公开台词的完整流式记录通过校验后原样送往演出，不再为重复或过时台词追加模型重写。重复台词跳过；失效台词保留诊断，材料改变后下一次正常调度可以重新选择，材料未变不会反复生成。自动解说默认回顾带时间的观察；明确声明 `current` 的台词仍须通过当前状态校验，不延长原始证据有效期。

部署者显式配置 `commentary.enabled`、`sources`（World ID，以空格分隔）、`hostStatusUrl`（宿主只读运行状态接口）及可选口吻。`idleSec` 默认 20 秒，`retrySec` 默认 20 秒，`factAgeSec` 默认 120 秒；均可在扩展配置页修改。没有已启用音频的页面、宿主暂停、资料过期或当前正在播放时，不提交解说。状态接口需要返回 `{ "loop": { "running": true, "paused": false } }`；不可读时等待恢复，不推断仍在运行。

起草只读取启用之后的新事件，以来源、时间、cursor 和截断标记提供最多六条预览。前台插话、暂停或关闭会淘汰待播台词；新聊天只使其来源 World 的待回复台词失效，不抹除已经发生的带时间观察。场景改变后不再播报过时的当前状态。提交时再次检查音频版本，后台台词不覆盖较新的语音或歌曲。最近台词用于去重；受理、合成、播放和结束仍分别记录。

桌宠播放回执携带已解码音频时长，用于在上一句接近结束时提前起草，避免为长音频过早消耗请求。歌曲、等待 TTS 的 queued 状态和无法确认类型的 busy 状态不预起草。动作目录刷新与音频合成、播放并行；迟到的表情和动作只允许附着在原音频上。`commentary-request`、`commentary-ready` 与 `commentary-submitted` 分别保留是否在播放中起草、起草和持有候选的耗时；它们不等于真实开播。

宿主可以识别来自已绑定播出 World 的 `[broadcast-speech-draft/v1]` 请求头，把该请求交给有限预算的单轮认知，附上宿主人格和近期台词。公共请求只使用 `brief`、`tools: []` 和 `hint.rounds: 1`，不要求非标准 Cognition 字段。人格、模型与记忆仍由宿主选择。`avatar_voice` 声明 `speak` 标签；主线程与后台解说都产生 `avatar.speech.submitted` 和原 action 的终态事件，宿主可按 `requestId` 合并台词记录。可选的 `requestFacts()` 仅供支持该只读表面的宿主采用，不是 API 6 的必需接口。

## 本地启动

要求 Node.js 22.15+，推荐 Node.js 24 LTS，并使用具备 WebGL 的现代浏览器。Cortico 0.2.4 的扩展检查使用 `node:module.registerHooks`，Node.js 22.14 不支持。开发构建：

```sh
npm ci
npm run typecheck
npm test
npm run build
node dist/standalone.js examples/stage.json
```

终端打印实际回环地址；配置 `port: 0` 自动分配端口。该默认示例没有人物或服务，不下载模型、不扫描端口。核心、独立服务和 SDK 的生产运行不需要安装 Cortico。

安装两个官方 VRM 预设之一：

```sh
npm run presets:install -- ./data/avatars vrm-twist-sample
```

将生成的 `data/avatars/installed.json` 中 `avatars` 数组写入部署配置。脚本使用固定版本和 SHA256；只在显式执行时下载。署名和许可证保留在目录、UI 和 OBS 画面。可米私人模型不随包分发。

打开页面，选人物；在一个播出页面点击顶部“开启声音”。`/?obs=1` 是透明背景播出入口。预览回执不会被当成播出成功。WebAudio 在点击内直接解锁，然后登记播出角色和申请唯一音频输出；刷新记住此标签页的选择，等旧页面租约释放后尝试恢复。如果浏览器禁止自动播放，顶部明确提示再点击一次，不把服务就绪或输出租约当成已经发声。

## Cortico 安装

构建后通过 Cortico 的本地扩展安装或 npm 安装机制加载本包，World ID 为 `avatar-stage`，API 6（Cortico 0.2.4 类型基线），默认关闭。参考配置见 [examples/cortico.json](examples/cortico.json)。可以在 World 内启动独立服务，也可以用 `remoteUrl` 连接已运行的同一台电脑上的服务；后者便于宿主重载时保留三维渲染服务。

启用前应把旧演出扩展的语音出口交接给这个 World。它不能跨 World 阻止旧扩展继续自动朗读，因此不能同时给两个 World 相同的自动播音职责。不要通过删除旧会话、目标或记忆完成切换。

本包没有隐藏 LLM 决策循环；动作和说话内容由宿主调用工具确定。若配置第三方歌曲网关，其审核、ASR 或模型调用属于该显式网关，应单独计费和观测。

## TTS 配置

```json
{
  "voice": {
    "url": "http://tts-gateway.local:4000/v1/audio/speech",
    "model": "your-tts-model",
    "voice": "your-voice",
    "voices": ["your-voice"],
    "tokenEnv": "AVATAR_TTS_API_KEY",
    "voicesUrl": "http://tts-gateway.local:4000/v1/audio/voices",
    "metricsUrl": "http://tts-gateway.local:4000/metrics/tts"
  }
}
```

只有 `url/model/voice` 是合成必需项。`voicesUrl` 与 LiteLLM 专用 `metricsUrl` 是可选扩展；普通服务无需实现。Bearer 从环境变量或受保护的 `credentialsFile` 读取，配置和状态不返回密钥。会话 ID 在 `dataDir` 下持久保存。默认请求 `response_format:"wav"`，不添加语速参数；播放端支持 8–96kHz/单声道/PCM16 WAV。切到原生 SSE 时，客户端请求 `response_format:"pcm",stream_format:"sse"`，按已确认的服务采样率消费。WAV 回执存在 `X-Speech-Stop` 时只接受 `complete`；设置 `voice.requireWavCompletion:true` 可要求该字段必填。Drama 3 没有可靠的数值调速接口，不发送 `speed`、`rate`、`tempo`，也不修改采样率冒充调速。本 World 不另开 LLM 改写正文。

三个追踪头 `x-litellm-call-id`、`x-litellm-session-id`、`x-tts-request-id` 随回执归档；若配置 metrics，只归档与本次请求匹配的服务端条目。

## SDK / 执行边界

```ts
import { AvatarStageClient } from "cortico-world-avatar-stage/sdk";
const client = new AvatarStageClient("http://127.0.0.1:18431", console.log);
await client.start();
try {
  const accepted = await client.invoke(
    "avatar_control",
    {
      action: "perform",
      gesture: "wave",
      durationMs: 2000,
    },
    "greeting-001",
  );
  const terminal = await client.wait(String(accepted.id), { timeoutMs: 15000 });
  console.log(terminal); // 以 renderer 回执确定成功、失败或取消。
} finally {
  await client.stop();
}
```

SDK 的 `stop()` 只断开这个 SDK；不停止独立舞台。`wait()` 取消只停止等待，动作取消需显式提交原 actionId。重试使用稳定 requestId，不能把 RPC 返回、任务受理、动作生成或音频传输完毕当成实际执行完成。

完整接口、自描述和事件由 `cortico-world-avatar-stage/tools` 的 `DESCRIPTION` 导出，同一来源用于宿主和 HTTP 能力页。同源声明导出 describe.json，按 Cortico 0.2.4 的正式自描述检查验收。0.1.x 旧宿主需升级后再加载这个 API 6 World；独立服务与 SDK 不受影响。

## 更多说明

- [无需部署推理模型的云服务接入](docs/cloud-services.md)
- [架构与中立协议](docs/architecture.md)
- [UniMate 本地部署、骨骼适配与许可证](providers/unimate/README.md)
- [音乐网关和曲库](docs/music.md)
- [本次验收结果与限制](docs/validation-20261020.md)
- [云服务接入与 API 6 验收](docs/validation-cloud-20261020.md)
- [第三方来源](THIRD_PARTY_NOTICES.md)

源代码使用 AGPL-3.0-only；模型、人物和音乐资产分别适用各自许可证。本包不内置可米形象、声音参考或模型权重。

歌曲制作由独立 AIGC World 负责；本版 avatar_music import 通过宿主素材句柄接收成品 WAV，旧生成入口返回迁移指引。现役旧 VTuber 扩展没有在这次源码调整中重载或修改。
<!-- Renderer owners: web/vrm-motion.js and web/vrm-body.js. -->

`VRMBodyLayer` is exported at `cortico-world-avatar-stage/renderer/vrm-body.js` for standard VRM desktop figures. The host supplies stage movement, direction, speed and action state. The layer adds spatial turning, seated and airborne poses, and visual hand props. Its transforms are restored before each mixer sample. Authored walking/running clips take precedence; a procedural gait is a fallback when those clips are absent. The layer does not operate game characters or inventory.
# Single-inference speech and performance

`avatar_voice` accepts explicit presentation cues in the same speech request:

```json
{"action":"speak","text":"我先看看附近。","performance":{"emotion":"relaxed","expression":"smile","bodyClip":"wave"}}
```

Use `avatar_voice` action `status` to read the current output's `performance.expressions` and `performance.bodyClips`. Emotion is retained as authored intent; expression selects the face, or defaults to the exact emotion id if no expression is supplied. These fields are never inserted into synthesis text and do not promise emotional voice synthesis. Omit performance when no cue is needed. The optional director is not invoked for explicitly authored cues.

The stage records speech and its requested cues together and binds their playback ids locally. Unavailable optional cues are omitted with `presentationWarnings`; valid speech continues. The original emotion remains authored intent. No substitute expression is inferred, and an explicit cue does not trigger a second model call when unavailable. Malformed cue fields still reject the request before replacing speech.

Desktop audio resolves its own vocabulary and attaches cues to the admitted audio job; the desktop starts queued cues when audio begins. A rejected cue is recorded separately and does not cancel the audio. Manual desktop body activity may take priority. `performanceCue.accepted` records delivery, not verified visual rendering. Desktop text uses the same cue resolver. A repeated speech request id does not repeat the performance. The resolver is exported from `cortico-world-avatar-stage/core` for other adapters.

Independent game tools can be emitted alongside speech; concurrency depends on the host dispatcher. Optional host cognition onText snapshots let commentary validate a complete sentence before model completion. At most one continuation is retained; input, foreground speech, revision changes and original evidence clocks still fence it. Incomplete objects, reasoning and restarted prefixes are never spoken. Hosts without streaming callbacks retain full-result compatibility. Desktop speech uses the same progressive PCM player as the stage page, with bounded transport and cancellation.

### Optional commentary during game actions

`commentary.enabled` enables task-only host cognition from fresh events. During confirmed speech playback it may prepare one candidate, using remaining decoded audio duration when available, and submit only after the configured idle gap. No audio is queued or synthesized ahead; music and unconfirmed busy output do not trigger lookahead. Set `commentary.sources` to the explicit World IDs whose new events may be used. The controller does not execute game tools or maintain a second conversation history. Existing foreground speech takes priority, and unchanged material can be skipped instead of producing repeated narration.

When `speechObservationMaxAgeSeconds` is configured, the controller reads each cited event from the host event store and forwards the oldest original timestamp as `observed_at`. It never substitutes the draft-completion clock or invents evidence for an uncited thought. The commentary evidence and generation window are bounded by the same speech policy. Ordinary conversation does not require a scene observation; explicitly supplied observation times retain freshness validation.

With `voice.busyPolicy: "preserve"`, a foreground line arriving during automatic commentary can reserve one upcoming audio gap. The immediate receipt says `queued`, `deferred: true`, `synthesisStarted: false` and supplies `expiresAt`; it does not mean playback. No second waiting line is admitted. Real playback completion releases the slot, then the stage rechecks the original `observed_at`, renderer and cancellation state before synthesis. The waiting timeout is `voice.pendingTimeoutMs` (60,000 ms by default, configurable from 1,000 to 300,000 ms), independent of evidence freshness. Interrupt, explicit cancellation, output release/change or shutdown cancels it. Ordinary foreground speech does not gain an unbounded audio queue. `avatar.speech.waiting` exposes this state; automatic drafting cannot take its slot.

Commentary diagnostics distinguish `model-skip`, `invalid-json`, `invalid-output`, and `duplicate-script`. A model's explicit skip reason is limited to 180 characters and redacted if it contains authentication material; it is not World evidence. These diagnostics do not force filler speech.


`voice.pendingTimeoutMs` defaults to 60000 (range 1000–300000) for one waiting foreground line; `voice.synthesisTimeoutMs` defaults to 90000. These are separate from observed-at freshness and the Persona-owned cognition deadline. Extending a queue timeout does not turn stale observations into current facts. Read `avatar_control status` for desktop support: installed expressions/motions and declared moves are available; raw bone control and uninstalled generated clips return an explicit unsupported result. Generated candidates can still be reviewed on the stage preview page.
