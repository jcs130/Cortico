# Cortico fork 维护

新的宿主修复以 [官方 Cortico](https://github.com/Pal-AI-Lab/Cortico) 为基线。可米当前维护分支为 [deploy/cortico-v0.2.17](https://github.com/jcs130/Cortico/tree/deploy/cortico-v0.2.17)，源自官方 v0.2.17 的 `cba606f6`。旧 fork 主干 v0.1.8 的 `8c00fbb0` 保存在 [legacy/fork-main-0.1.8](https://github.com/jcs130/Cortico/tree/legacy/fork-main-0.1.8)。

| 改动 | 源码归属 |
| --- | --- |
| 宿主生命周期、事件投递、会话及 WebUI | Cortico fork，通用修复提交给官方 |
| Bilibili、Console 的内置接入 | Cortico 的对应 World，沿用官方事件和扩展契约 |
| 通用 Minecraft 感知、动作、脚本和学习 | [minecraft-ai-friend](https://github.com/jcs130/minecraft-ai-friend) 的 `packages/agent-mc-world` |
| 千灯纪协议与宿主适配 | [cortico-world-qiandengji](https://github.com/jcs130/cortico-world-qiandengji) |
| 观战渲染 | [mc-visual-console](https://github.com/jcs130/mc-visual-console) |
| 可米人格、记忆策略和演出 | 独立的 Bot 与演出扩展，各自验收和打包 |

## 跟进上游

1. 读取官方 `main`、正式标签、发行说明和 fork 维护分支。从经确认的官方提交建立独立工作树。
2. 用 `git log --first-parent <官方提交>..<维护分支>` 盘点本地补丁。用 `git show` 核对官方是否已覆盖行为。按依赖顺序重放仍缺的补丁，并逐项记录来源、实际消费者和回归用例。
3. 旧代码按行为迁移。Bilibili 的普通进场与进场特效在候选投递时归并，原始事件照常归档。官方主循环会调用 Bot 提供的模型适配器，可米现用的思考档位通过该接口投递。旧 `beforeDecision` 控制台快速提示在现用配置中停用。
4. 运行宿主类型检查、相关测试、WebUI 构建和成品打包。在独立目录对实际扩展逐个检查，覆盖公开 SDK、插件生命周期和关键回执。记录官方基线、本地补丁、测试结果、包哈希和回退入口。
5. 候选通过后合并到维护分支。需要加载时通过启动器切换已验证成品，记录实际进程、宿主提交、扩展版本和游戏终态。

## 旧主干迁移

旧主干还包含从仓库拆出去的千灯纪、演出和可视化代码，以及旧 Terminal World。独立扩展以各自仓库为准，旧 Terminal 的迁移见 [升级指南](upgrading.md)。仍随官方发版的内置 Bot 和 Minecraft World 逐项检查旧差异及当前消费者。默认分支迁移前，用保留双方历史的合并提交整合并验证。用 `git merge-base --is-ancestor` 确认旧主干和新基线均在提交历史中，用 `git diff <已验证候选> HEAD` 核对最终源码。
