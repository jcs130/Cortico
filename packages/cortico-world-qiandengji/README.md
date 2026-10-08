<!-- Owner: src/world.ts, src/guild-progress.ts, src/server-guide.ts, src/ENV_PROMPT.md, references/server-technical/index.json -->

# cortico-world-qiandengji

「千灯纪」服务器的 Cortico World 扩展。World ID 保持 `mymc`，工具名为 `mymc_*`，避免已部署配置和笔记改名。游戏连接和动作执行复用 Cortico 的 Minecraft 引擎；扩展负责服务器规则、技能目录观察、快捷抵达与入塔装备检查。

现代网页画面源码位于独立仓库 [mc-visual-console](https://github.com/jcs130/mc-visual-console)，不是本 World 的一部分。区块、实体、物品栏、交易窗口、生命与天气等来自普通 Mineflayer 连接；千灯纪额外的魔力/冷却、施法成功事件和命名 NPC 美术使用独立协议或预设。普通 Minecraft World 可以只用前者。

这是供贡献审查的源码。当前 Cortico 公开版 `0.1.4` 尚未包含 `agentFriendProtect` 路径保护预检、`mc_cast` 和 `mc_combat_tactic`，因此本包目前需要包含这些能力的 Cortico 构建。启动前会检查所需工具和保护模块，发现缺失时明确报错。该能力进入上游并发布后，再确定本包的最低兼容版本。

## 契约

`flight` 指南说明施法前的整段只读路线试算、累计耗时与许可时长预算，以及施法、分段飞行和落地的同单编排。

`control` 指南说明通用引擎提供的短时方向、跳跃、相对视角及许可内斜飞，按实际回执修订动作组合。现役引擎必须在 `mymc_help` 中声明该技能；扩展不伪造飞行许可，不把工作区方法写权限解释为源码修改权限。
立即施法仍用 `mymc_cast`；需要保持执行顺序的限时移动使用 `mymc_do` 的完整命令和依赖步骤。
动作可用性以当前 `mymc_help` 为准，发送命令不证明服务端已授予许可。

完整当前读数沿用通用引擎的快照采样。`requestFacts()` 同步读取带时间的缓存，并映射对应的
状态事件类型；代理不支持该能力或尚无有效读数时返回 `null`。Persona 可用该完整读数替代旧增量链。
引擎提供完整分段 `parts` 时，扩展保留稳定键并逐段映射工具名，技能索引另成一段；位置或采样时刻变化不会要求重放整份目录。
千灯纪在完整读数中附加 `/mycli` 技能入口、分类索引与分页查询进度；完整说明由
`mymc_skills {"id":"..."}` 按需展开。目录按服务器持久化，只有收齐所有页和声明的项目数
才标为完整并移除旧项；命令元数据改变后，旧详细说明失效。目录不证明本人已学会或当前可施放。
施法前按已观测命令中的必填和可选占位符校验参数数量；无参数命令拒绝多余坐标。
未知、可变参数或无法解析的语法交给服务端裁决，目录更新后使用新参数约束。
`src/guild-progress.ts` 保留服务端接单与验收原文及其观察时间，同一委托的进度更新继续携带该证据。
进度同时读取状态查询和交付时的“还需完成”回执，按观察时间更新，允许实测数下降；进度不是累计捐赠量或完成证明。
在办看板按同一委托名称补充精确 ID；切换、交付或确认无在办委托时清除旧要求，重载按服务器与账号恢复。
看板描述、台词和请求次数不能替代验收回执。

常驻环境提示提供权限、保护和事实核验边界；试炼、收纳、飞行、社交等细则通过
`mymc_guide {"topic":"..."}` 按需读取。省略 `topic` 返回主题索引。原版动作参数由
通用引擎的 `mymc_help` 提供；技能最新说明仍以服务端目录、本人状态和回执为准。

- npm 包名：`cortico-world-qiandengji`
- `cortico.kind: world`，`cortico.api: 5`
- `WorldDefinition.id: mymc`，配置段：`worlds.mymc`
- `host`、`username` 默认空；测试与构造不连接服务器
- 不包含服务器 IP、登录凭证、运行账本或 Minecraft 资源

## 开发检查

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

使用含保护预检能力的 Cortico 源码时，再从 Cortico 仓库运行 `pnpm check:extension <本目录>`。构造检查不会启动游戏连接。

## 部署

将本包作为 World 扩展安装，在部署配置中启用 `worlds.mymc`，填写服务器地址、端口、协议版本与普通玩家账号。先停用 `worlds.minecraft`，避免同一账号双开。环境提示词通过本包的 `src/ENV_PROMPT.md` 提供，服务端新增技能由游戏内 `/mycli` 回执观察、核验后使用。

在 Cortico 的 `extensions/package.json` 中加入本包的 `link:` 路径后，于 `extensions/` 运行 `pnpm --ignore-workspace install`，再运行 `pnpm check:extension <本目录>`。构建后的网页目录由 `worlds.mymc.viewerAssetsDir` 指定；它来自 `mc-visual-console` 的源码和本地 1.20.6 客户端资源。

另一台机器的仓库分支、构建顺序、技术资料导入和私有资产迁移见 [DEPLOYMENT.md](DEPLOYMENT.md)。`references/server-technical/` 随包分发，由部署者导入文件工作区；World 不写入 Persona Memory。
