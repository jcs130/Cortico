<!-- Owner: src/worlds/minecraft/viewer-state.ts, viewer-combat.ts, viewer-presentation.ts -->
# 千灯纪 Agent 状态与演出协议 v1

服务端按**当前玩家连接**单播 Minecraft `custom_payload`，不要按 CortiLan 等用户名分支。任意 Mineflayer 或其他实现同一协议的 Agent 客户端都可订阅；未实现协议的原版客户端会忽略这些机器消息。不要把周期状态或 JSON 发到聊天、公屏、私聊、系统提示或标题。玩家聊天和真正需要玩家处理的失败原因仍走正常消息通道。

## `mcagent:state`

UTF-8 JSON，最大 16 KiB。AgentFriend 0.3.58 在登录、重生、施法、魔力或冷却变化时向玩家连接发送完整快照；数值未变化不重发。`abilities` 是本人当前可用的技能列表。

```json
{
  "schemaVersion": 1,
  "mana": { "current": 23, "max": 32 },
  "abilities": [{ "id": "mycli:starbolt", "name": "星芒箭", "level": 1,
    "cooldownMs": 3000, "cooldownRemainingMs": 1750, "icon": "minecraft:amethyst_shard" }]
}
```

`mana: null` 表示数据尚未加载，不能解释为零魔力。`cooldownMs` 是总冷却，`cooldownRemainingMs` 是剩余冷却；后者为 `null` 时状态未知，等于零才表示冷却结束。`icon` 是可选的 1.20.6 原版物品 ID。魔力不足、无目标等条件仍可能使施法失败。客户端以该频道替换技能列表；旧 `mcviewer:state` 只补充等级和经验，它的 `abilities[].cooldownMs` 表示剩余冷却，不能当作总冷却。旧 `corti:viewer_state` 仍可作为无新频道时的回退。

## `mcviewer:combat`

UTF-8 JSON，最大 2 KiB。一次已结算且未取消的伤害发送一次，只单播给攻击者。`damage` 是服务端结算后的实际伤害值，`critical` 只有服务端确认暴击才为 `true`；无法判断时填 `false`。`attackerEntityId`、`targetEntityId` 是本次连接看到的 Minecraft 实体 ID。远程攻击由服务端解析投射物的攻击者。

```json
{
  "schemaVersion": 1,
  "attackerEntityId": 123,
  "targetEntityId": 456,
  "damage": 5.5,
  "critical": false
}
```

客户端用 `attackerEntityId` 校验接收者，再在 `targetEntityId` 上显示伤害数字。普通受伤动画包没有伤害量或攻击者的可靠归属，因此不能据此显示数值或判定暴击。

## `mcagent:event`

UTF-8 JSON，最大 4 KiB。仅在**离散事件**发生时发送，不用它流式同步状态。

```json
{
  "schemaVersion": 1,
  "kind": "skill",
  "id": "goddess:flame_wave",
  "title": "焰浪",
  "body": "命中 3 名敌人",
  "tone": "arcane",
  "position": { "x": -500.5, "y": 65, "z": -317.5 }
}
```

`kind`：`skill`、`quest`、`notice`、`combat`、`environment`、`achievement`。`tone`：`positive`、`neutral`、`warning`、`danger`、`arcane`。`position` 可省略；有坐标时网页可显示空间特效。`id` 为可复用的稳定事件标识，长度最多 80；`title` 最多 80 字，`body` 最多 240 字。当前客户端兼容旧 `mcviewer:event`。

## 通道分工

| 信息 | 发送方式 | 进入 Agent 上下文 |
| --- | --- | --- |
| 魔力、技能、经验、冷却等周期状态 | `mcagent:state` | 不逐条进入；需要决策时由 Agent 读取简短状态 |
| 技能施放、任务节点、稀有掉落等演出 | `mcagent:event`；可同时发送原版粒子/音效 | 只在行动有意义时发送摘要 |
| 已结算伤害数字与暴击 | `mcviewer:combat` | 默认不逐条进入；由战斗任务按需汇总 |
| 普通玩家聊天、私聊 | 原版聊天 | 按 Agent 的互动策略进入 |
| 施法失败、权限拒绝等可执行反馈 | 原版系统消息或专用语义事件 | 进入当前任务的反馈通道 |
| 原版粒子、爆炸、药水效果、进度、计分板 | 原版协议包 | 网页直接渲染，不进入上下文 |

不要广播 `MC_PROTECT`、探针 JSON、状态快照等机器回执给其他玩家。它们应只发给发起查询的玩家，并优先走专用插件消息。

## 网页扩展点

网页把消息先归一化为语义事件，再分给 HUD 和 Three.js 特效层。之后可用 `window.MinecraftViewerPresentation.register(kind, handler)` 增加特定事件演出，用 `registerTheme(id, tokens)` 注册配色，并用 `setTheme(id)` 切换。配色 token 包括 `--mc-viewer-vfx-fire`、`--mc-viewer-vfx-arcane`、`--mc-viewer-vfx-life`、`--mc-viewer-vfx-water`、`--mc-viewer-vfx-combat`、`--mc-viewer-vfx-neutral`、`--mc-viewer-ui-bg`、`--mc-viewer-ui-border`、`--mc-viewer-ui-text`。旧 `--corti-` token 仍可注册为别名。接口不依赖 CortiLan 账号；皮肤素材包可以随后接入同一资源层。

本机 `/viewer-coverage` 只记录协议包名、插件通道名和数量，不记录消息正文。`renderLane: "unmapped"` 代表需要检查的新包；协议控制包没有画面表现。
