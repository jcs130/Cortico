<!-- Owner: scripts/setup-bundled.ts, package.json, pnpm-workspace.yaml -->

# 从个人 fork 部署

主框架、千灯纪 World、VTuber 演出和现代网页渲染器均在
[jcs130/Cortico 的 main 分支](https://github.com/jcs130/Cortico/tree/main)。
模块仍各自维护接口，安装使用根目录的一份 pnpm 锁文件。

## 安装与启动

准备 Node.js 24、pnpm 11.5 和 Python 3，在新目录执行：

```powershell
git clone --branch main https://github.com/jcs130/Cortico.git
cd Cortico
pnpm install --frozen-lockfile
pnpm setup:bundled
pnpm start --new
```

选择 `cortiv` 创建部署。已有部署执行 `pnpm start <部署名>`。
`setup:bundled` 安装渲染器工具依赖、构建并注册两个 World；保留其他已安装扩展，替换旧安装前备份其注册文件和包目录。
更新代码后在未运行的目标部署上执行 `git pull --ff-only`、安装依赖并重新执行此命令。

模型服务、凭证、服务器、玩家账号和各 World 开关在网页控制台配置。
连接千灯纪时启用 `worlds.mymc`，停用 `worlds.minecraft`，避免重复连接。
IndexTTS 与制歌模型服务需要单独安装、配置；参考音频、模型权重、Live2D 和歌曲不随源码发布。
详见 [语音适配器](../packages/cortico-world-vtuber/adapters/indextts/README.md) 和
[音乐服务](../packages/cortico-world-vtuber/src/MUSIC_VOICE.md)。

## 网页游戏画面

源码位于 `packages/mc-visual-console/packages/modern-viewer/renderer-src/`。
按照该目录的 [构建说明](../packages/mc-visual-console/packages/modern-viewer/renderer-src/README.md)，
使用自己持有的 Java 1.20.6 客户端资源导出贴图、声音和界面，再构建浏览器产物。
该渲染器工具保留独立的 npm 锁文件与依赖版本；它不在根 pnpm 工作区内，由 `setup:bundled` 安装。
千灯纪画面可选择 `--preset=qiandengji`。
将 `worlds.mymc.viewerAssetsDir` 指向导出的资源目录。

## 保留同一位主播

私下迁移原 `deployments/<部署名>/`，包括配置、提示词、workspace、World 存储和运行账本。
复制前停止源端对应部署，迁移后修改盘符、服务地址和资源路径；同一 Minecraft 账号只保持一处连接。
Git 不包含这些私人数据或密钥。已有记忆不应被新部署的模板覆盖。

服务器与项目资料在 `packages/cortico-world-qiandengji/references/server-technical/`，
导入方法见 [World 部署说明](../packages/cortico-world-qiandengji/DEPLOYMENT.md)。
这些资料包含带日期的部署事实，迁移后按实际配置订正。

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm test:bundled
pnpm typecheck:bundled
pnpm check:extension packages/cortico-world-qiandengji
pnpm check:extension packages/cortico-world-vtuber
```

测试与扩展检查不连接真实游戏。启动后另外核验 Minecraft 连接、原目标与待办、一次任务终态、
语音、歌曲播放、网页人物和背包，以及观众记忆查询。

## 源码与许可

导入版本见 [模块来源](../packages/README.md)。主框架和各模块保留各自许可；
VTuber 扩展使用 AGPL-3.0-or-later，其余模块的许可及第三方声明见各自目录。
