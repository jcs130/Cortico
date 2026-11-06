# src/core、src/index.ts：3D 演出状态与宿主适配

# 架构与协议

## 边界

| 层                  | 维护内容                                                 | 不承担                              |
| ------------------- | -------------------------------------------------------- | ----------------------------------- |
| `src/core`          | 人物能力、动作账本、取消、音频拥有者、显式模型服务客户端 | 人格、目标、长期记忆、隐藏 LLM 循环 |
| `src/server.ts`     | 回环 HTTP、工具校验、事件、静态资产与音频代理            | 外网端口扫描、自动下载              |
| `src/sdk.ts`        | 中立工具调用、事件订阅、可取消等待                       | 自动重投动作、停止远端服务          |
| `src/index.ts`      | Cortico API 6 薄适配器、提示词事实、宿主事件             | 改写旧 VTuber 或 Minecraft World    |
| `web`               | VRM/GLB 渲染、动作混合、WebAudio、真实执行回执           | LLM 规划、服务器凭据                |
| `providers/unimate` | 独立、显式启动的文本到身体动作进程                       | 自动选择云服务、接管宿主人格        |

`core/server/sdk/tools` 无 Cortico 运行时依赖。Cortico 类型只出现在薄适配器。Three.js 和 three-vrm 由包管理器解析并在本地提供，不从 CDN 取脚本。

## `avatar-stage/1`

- `GET /api/capabilities`：工具和事件自描述。
- `GET /api/state`：当前事实；包括人物哈希、真实能力和音频拥有者。
- `POST /api/call`：`{tool,args,requestId}`。requestId 标识一次逻辑动作；稳定 ID 的相同请求不再执行，改参报错。
- `GET /api/actions/:id`：动作终态。
- `GET /events`：SSE JSON 事件。首次 snapshot 是事实，不是待执行队列。音频通过独立二进制 WAV HTTP 传输，不走 SSE。
- `POST /api/receipt`：renderer 的 sessionId、角色、人物 SHA256、actionId 和 applied/playing/ended/failed 等证据。
- `POST /api/audio-owner`：一个播出 renderer 申请音频所有权，心跳续约。

工具 `avatar_control history` 提供最近原请求与当前执行证据。`dataDir/events.jsonl` 保留原始请求、全部回执、被忽略的迟到回执及传输追踪；`actions.json` 是当前动作状态，`music-jobs.json` 是只读兼容的历史生成归档。资产和端点来自显式配置，不自动扫描旧演出端口。

身体执行：`queued → playing → completed | failed | cancelled`。选择人物以实际 `applied` 确认。终态不可逆，停止后的迟到成功不得复活动作。重启时未对账动作标记失败，不自动重放。预览与播出分别留证，音频传输结束不是播放结束。

模型任务：受理 jobId、生成状态、候选检查、采用、播放 actionId 分开。歌曲 ready 不自动播放。网络超时后保持不确定记录，按原 ID 对账，不自动生成第二份。

## 渲染与资源

载入验证 GLB/VRM SHA256；模型必须嵌入纹理与 buffer，拒绝外部资源 URL。动作只驱动声明的骨骼和表情。VRM 规范化人形姿态与原始骨骼动画不能同时覆写；播放 UniMate 原始骨骼轨迹期间暂停 normalized→raw 覆写，结束后渐变恢复。

本地服务只绑定回环，拒绝非本地 Host 和跨源写入。远程 OBS 或控制接入需要部署者另行配置受保护的代理；本版本不会自行开放公网接口。

## 提示词与迁移

固定说明在 `src/prompt.md`，动态事实通过 `avatar_query` 和 Core 事件放在当前事实区；不往稳定前缀插入时间或长历史。宿主负责提示预算及记忆。本 World 的 envPromptVars 保持空对象，只暴露当前短摘要，原文留在账本。

自动解说在起草前为每条材料投递 `citationWindows`，列出可用的当前描述或回顾时态及其截止时间。它与播放受理使用同一原始观察时钟；后续新读数、起草和排队都不延长旧材料寿命，过期台词不自动改写时态。

旧 World 保留。迁移时显式把说话、音乐和人物动作工具交给新 World，保留游戏 World、会话、人格、目标、记忆及旧曲库。曲库可以只读引用；动作库只复用目标人物 SHA256 和生成配置匹配的记录。可米模型继续在私人资产项目维护，不混进公开预设。

## 2026-10-20 所有权收口

体素采集、记录、相机配准与原始字节校验归 `agent-mc-world/capture`；EdenLive 视频推理归 AIGC 的显式 provider，应用组合例子同样迁出本包。UniMate 属于实时身体动作，保留在本包。旧歌曲生成端点仅用于兼容归档配置，不会再提交；显式导入生成 WAV 后才可采用和播放。SDK/World 取消终止本次等待或 HTTP，请勿将其视为已受理远端动作已撤销；动作撤销须显式 cancel。停止使旧事件失效，不自动重连其他进程。
