# 个人 fork 部署迁移

本页接续 v0.1.8 的整包安装说明。使用 [v0.2.17 维护分支](https://github.com/jcs130/Cortico/tree/deploy/cortico-v0.2.17) 的部署，从 [部署说明](deployment.md) 和 [扩展说明](extensions.md) 开始。旧版源码和整包安装说明保存在 [legacy/fork-main-0.1.8](https://github.com/jcs130/Cortico/blob/legacy/fork-main-0.1.8/docs/bundled-deployment.md)。

新版宿主通过各项目的独立成品加载扩展。

| 组件 | 维护仓库 |
| --- | --- |
| 千灯纪 World 与协议包 | [cortico-world-qiandengji](https://github.com/jcs130/cortico-world-qiandengji) |
| 游戏核心 | [minecraft-ai-friend](https://github.com/jcs130/minecraft-ai-friend/tree/main/packages/agent-mc-world) |
| 观战和渲染 | [mc-visual-console](https://github.com/jcs130/mc-visual-console) |
| 演出 | [cortico-world-avatar-stage](https://github.com/jcs130/cortico-world-avatar-stage) |

从原部署迁移时，先记录已加载的版本、原部署目录、扩展清单和观察到的外部连接。用已验证的成品版本装配候选宿主并运行 `pnpm check:extension <包目录>`。切换前停止原部署并保留原启动入口作为回退路径；从候选宿主启动同一部署，再核对会话、目标、World 挂载和连接状态。迁移原生 Terminal 配置时，按[升级指南](upgrading.md)使用 Console 的名称和接口；已有 Console 配置时优先核对现役组件。

旧 `pnpm setup:bundled` 为旧目录结构注册本地源码链接，会覆盖独立成品的选择。已有部署的角色配置、记忆、凭据、模型与账本均随原数据目录管理。源码维护与上线验收见 [Cortico fork 维护](fork-maintenance.md)。
