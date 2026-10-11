<!-- Owner: src/worlds/minecraft/battlefield.ts, src/worlds/minecraft/combat-decision.ts, src/worlds/minecraft/combat-reactions.ts -->
# 战场状态与异步战术选择

`combatDecision` 从游戏时钟直接采样实体、原版血量元数据、属性、当前位置、视线、动作和本连接能力状态，向 `state/questions` 接口发送有界请求。动作包含当前攻击目标、距最近命中的毫秒数及身体是否允许短步；没有控制器读数时目标与命中时长为 `null`。主模型的排队与推理不参与这条路径。一个选择尚未结束时不再发第二个；攻击和已有导航继续运行。

默认关闭。启用后 `shadow` 只记录快模型建议，原战术继续。`act` 可发送已有规则授权的法术；规则填写 `intent`，简述已查阅的技能作用和用途。未知能力、魔力或成本、规则不匹配、目标不可见时不提供该法术。规则顺序决定候选上限内保留的法术；`intent` 不证明已经学会。`selfheal` 与现有低血避险先处理。

`allowEngage` 允许身体空闲且没有待办或运行中脚本时选择接敌，仍遵守 `fight` 策略、装备、血线和战斗时限。`engageScope:party` 需要服务器明确报告敌人正攻击自己或队友；`hostile` 可选择可见敌对类型，需由部署方明确启用。接敌后现有攻击控制器持续接近和出手。

`allowMovement` 在近战控制器超过 `movementStallMs` 未命中时提供短步与撤退候选。1.2格短步检查已加载平地、脚部与头部净空、身体宽度、危险方块和终点余量，最多执行700毫秒。执行时每拍重查；出手相位、补给、寻路、远程射击与环境自救保留控制权。撤退复用既有撤退控制器。额外动作不取消脚本，也不插入新的身体任务。

返回后重采样并核对连接代次、维度、战术版本、血量、魔力、目标身份、视线、当前任务与可执行条件。超过 `maxAgeMs`、位移过大或条件变化的选择作废。超时、无效回答或低概率选择恢复原战术的现场检查，不执行模型推荐动作。诊断 `decision-requested/result/error` 保存有界输入、请求字节、选择概率、耗时、服务返回的用量及是否真正发送；发送仍不是服务端确认成功。

## 血量与队友身份

原版实体血量仅按当前版本注册表的 `metadataKeys` 读取，不固定元数据下标。缺少血量或最大血量时保持 `null`，不从命中次数估算。血量更新时间保持最近收到相关包的时间，不用采样时间冒充更新。原版记分板同队单独记录为 `scoreboardTeam`，不据此确认 RPG 队伍关系。

服务器若未发送玩家血量、队伍和攻击目标，可按连接单播以下补充协议。未实现时上述字段保持未知；客户端仍可使用已收到的原版事实。

## `mcagent:battlefield`

Minecraft `custom_payload`，UTF-8 JSON，最多32 KiB。不要发到聊天频道。字段全部必填，未知值用 `null`。每个包是完整快照，最多64个实体；`sequence` 在同一连接/重生代次内单调递增。客户端收到包后以本地时钟计算有效期，无需服务器与客户端对时。

```json
{
  "schemaVersion": 1,
  "sequence": 42,
  "dimension": "minecraft:overworld",
  "validForMs": 1000,
  "entities": [
    {
      "entityId": 23,
      "uuid": "00000000-0000-0000-0000-000000000023",
      "type": "player",
      "name": "Companion",
      "relation": "ally",
      "health": { "current": 8, "max": 30 },
      "targetEntityId": null
    },
    {
      "entityId": 57,
      "uuid": "00000000-0000-0000-0000-000000000057",
      "type": "zombie",
      "name": "Guard",
      "relation": "hostile",
      "health": { "current": 35, "max": 80 },
      "targetEntityId": 23
    }
  ]
}
```

- `relation`: `ally`、`hostile`、`neutral`、`unknown`，相对于接收玩家。`ally` 应来自实际队伍关系。
- `entityId`: 原版运行时实体编号；未跟踪的队友可为 `null`。实体号与 UUID 同时匹配才覆盖本地实体事实，防止复用实体号串到其他怪物。
- `uuid`: 必填实体 UUID。`type` 为实体 ID，未跟踪队友可为 `null`；`name` 可为 `null`。
- `health.current/max`: 非负实际生命值，未知可为 `null`；已知最大值必须大于零，当前值不得超过它。不要用原版20生命覆盖 RPG 自定义最大值。
- `targetEntityId`: 服务端实际攻击目标，未知可为 `null`；不得把最近玩家当作攻击目标。
- `dimension`: 当前维度。原版简写与 `minecraft:` 前缀等价，其他命名空间精确匹配。
- `validForMs`: 1–5000毫秒，建议1000毫秒且至少每500毫秒刷新；实体死亡、换目标、队伍改变时立即刷新。到期、重生、断线或维度不符后不沿用旧队友和血量事实。

本地仅测24格内的实体位置与视线。未跟踪队友可以有服务端血量，其位置、距离与视线保持 `null`。超过 `maxEntities` 的实体按距离截断并报告省略数量；快模型不能把省略解释为不存在。
