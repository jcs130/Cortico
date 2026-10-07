<!-- Owner: package.json, references/server-technical/index.json, src/ENV_PROMPT.md -->

# 在另一台机器部署

主框架、千灯纪 World、演出与网页渲染源码均已整合到
[jcs130/Cortico 的 main 分支](https://github.com/jcs130/Cortico/tree/main)。
安装与资源准备见仓库 [统一部署说明](../../docs/bundled-deployment.md)。

## 安装代码

准备 Node.js 24、pnpm 11.5 和 Python 3，在新目录执行：

```powershell
git clone --branch main https://github.com/jcs130/Cortico.git
cd Cortico
pnpm install --frozen-lockfile
pnpm setup:bundled
pnpm start --new
```

选择 `cortiv` 创建部署。模型服务、凭证和 World 开关在网页控制台配置。启用 `worlds.mymc`，停用 `worlds.minecraft`，填写服务器和玩家账号。
本模块的开发检查从仓库根执行 `pnpm --filter cortico-world-qiandengji test` 和 `pnpm --filter cortico-world-qiandengji typecheck`。

网页游戏画面按 [渲染器说明](../mc-visual-console/packages/modern-viewer/renderer-src/README.md) 用自己持有的 Java 1.20.6 客户端 JAR 导出资源；千灯纪画面选择 `--preset=qiandengji`。将 `worlds.mymc.viewerAssetsDir` 指向生成目录。

## 导入技术资料

`references/server-technical/` 包含服务器加入说明和项目问答，带来源、适用范围与更新时间。它使用已有的 `read_file` / `grep_files`，无需检索服务。这些 JSON 不是玩法 `reference_guide` 的活动索引，不填入 `references.indexFiles`。

从本扩展目录将整个 `references/server-technical/` 复制到 `<部署>/workspace/references/server-technical/`。已有同名资料时先比较更新时间和内容，保留已订正的版本。然后在控制台 Persona 页的存在方式提示末尾加入这一段并重载前缀：

```text
服务器和项目技术资料入口是 references/server-technical/index.json。观众问到时用 read_file 读目录、grep_files 定位并分段读取相关原文，再用白话简短回答。保留来源与适用时间，技术正文按需查阅。
```

模型和音色问答记录的是 2026-10-07 的部署快照；迁移后核对新机器实际配置再修改。服务器公开地址、基岩端口和精确版本范围尚未确认，不从旧客户端配置推断。

## 迁移当前个体与媒体

要保留同一位主播的记忆，私下复制原 `<部署>/workspace/`、`prompts/`、`worlds/`、`deployment.json`、`config.json` 与 `.env`；这些文件不在 Git。修改配置中的旧盘符、服务地址和资源路径，核对提示词覆盖文件是否需要订正。`data/` 包含运行账本和恢复状态，迁移时先停止源端的对应进程再复制，避免正在写入的文件不完整。

IndexTTS 模型服务、发音资源、参考音频、Live2D 资源、音乐模型、歌曲文件与目录配置分别迁移或重新安装。适配器代码随演出扩展发布，安装和控制台设置见其 [IndexTTS 说明](https://github.com/jcs130/cortico-world-vtuber/blob/feat/live-music-20261006/adapters/indextts/README.md)；制歌流程和所需模型见 [音乐说明](https://github.com/jcs130/cortico-world-vtuber/blob/feat/live-music-20261006/src/MUSIC_VOICE.md)。服务端点中的 `127.0.0.1` 指向新机器本身。

迁移完成后核验：主循环与 Minecraft 连接、现役目标和技能入口、一次实际任务的终态、一次语音、一次已有歌曲播放、网页人物和背包，以及观众档案检索。启用后台规划和快判断前，先确认各自模型服务可达。同一 Minecraft 账号由一台机器保持连接，切换时关闭源端连接。
