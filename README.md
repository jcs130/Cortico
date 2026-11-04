# CormyLive.cs / 可米直播桌面入口

## 直播小助手

独立服务器观战支持“只看可米”“指定玩家”“自动切换”。`PrimaryTargetName` 配置主角实际游戏名；其他玩家按当前原生名单及 UUID 选择。选择写入同一实例的 `config/mcvisual-broadcast-selection.json`，导播即时读取，不重启 Agent、客户端或音频。状态显示实际相机跟随对象，提交不冒充切换完成。固定玩家离线时等待，不自动换人；恢复自动模式后按真实活动选镜头，空闲角色不因缺少出镜时间抢镜。

`StudioWindow.cs` 提供 380px 宽的独立控制窗：打开／切回观战客户端、动态读取当前 World 的网页观战地址、显示现有透明形象、复制 OBS 浏览器源地址，以及控制台、置顶和托盘。透明形象仍由已安装的静音展示程序负责，声音仍走原演出播放器。面板只读刷新状态，不自动启动 Agent 或观战端；关闭面板不停止直播。重复打开会显示原面板，透明形象复用原程序的单实例。

安装使用 `install-studio.ps1 -AvatarExecutable <现有Electron绝对路径> -AvatarApp <透明形象程序目录>`。默认读取 `I:/CormyLive/settings.json`，新建独立的 `Cormy.Live.Studio` 按需任务及桌面“可米直播小助手”快捷方式；不更新或停止 `Cormy.Live`、`Cormy.Live.Panel`，不改宿主配置。`studio-active.json` 记录实际程序及配置路径，窗口位置和置顶保存到 `studio-window.json`。没有开机触发器。删除小助手时只处理这个新增任务、快捷方式和对应版本目录，不处理宿主。

小助手明确区分两种入口：未配置独立观战时显示“个人游戏观战”，使用当前官方 `/api/webui/providers/.../panels/mount/client.*`；配置独立观战后显示“服务器直播观战”，只使用该实例的启动器和原生状态，不调用 World 的 `client.start`，失败也不回退到个人 eye。独立观战按钮不依赖宿主控制台在线。网页地址仍通过 World 的 connection 面板读取。

独立观战安装增加 `-ObserverConfig <JSON绝对路径>`。该 JSON 使用 `StandaloneObserverSettings` 字段：`ProfileDirectory`、`LauncherExecutable`、`LauncherScript`、可选 `SelectorFile`、`ExpectedAccount`、`ExpectedServer`、`ExpectedUuid`、`ExpectedLoader`、`ExpectedJavaExecutable`、`NativeVersion`、`ObserverVersion`、`Artifacts`（`RelativePath` 与 `Sha256`）。它指向已安装、已验收且自身具备单实例保护的 mc-visual-console 启动器；不下载客户端，不复制登录凭据，也不修改自动重连配置。版本升级须同步这份清单，校验不符时停止打开。再次安装小助手未传此参数时，保留上一版独立观战配置，避免退回旧入口。

打开前核对选择文件与发行包哈希；状态读取交叉核对真实进程的启动时间、Java 路径、`--gameDir`、`--username`，以及原生窗口 PID、加载版本、服务器与 UUID。命令行仅在内存中提取身份字段，不记录令牌。过期帧、PID 复用和身份不符都不会显示“跟拍中”，启动器返回也不等于客户端已完成启动。该接入只读 `process.json` 与 `diagnostics/mcvisual-native-{window,director,observer}.json`，不会把旧验收字段当作当前状态。小助手刷新只读，关闭小助手不停止观战。

`test-studio.ps1` 用随机本机端口的假宿主验证个人观战启动、重复打开、失败状态及链接限制，并用临时文件和可注入进程边界验证独立观战的实例、PID、身份、版本、时间戳、发行包与启动终态；不调用真实游戏、模型或音频，真实界面另行检查。预览可运行 `CormyLive.exe --studio --config <settings.json> --studio-config <studio.json> --preview <output.png>`，该模式不访问运行服务。

`audio-host.cjs` 可作为官方桌宠 `CORTICO_DESKTOP_PET_HOST` 的显式外壳：使用已安装 Electron 运行本文件，沿用宿主传入的 `--pet-url`、`--parent-pid`。它在独立配置目录中加载原桌宠媒体页，后台播放仍使用原演出接口、音频队列和实际播放回执。启用需保留桌宠 `media.backgroundAudio=true`；形象可由现有独立窗口展示。它不启动 TTS、模型或游戏。`node --test test-audio-host.mjs` 检查地址及宿主生命周期参数。

`install.ps1` 安装 Windows 桌面应用和两个按需运行的任务：直播宿主、控制面板。二者由 Windows 任务计划程序启动，与发起启动的终端、Codex 和面板窗口独立。无开机触发器，无异常自动重启。

安装后双击桌面“可米直播”。启动、暂停、继续和停止分别调用官方入口或公开控制台 API。关闭面板保留直播；“停止直播”沿官方关机流程执行，不强制杀进程。控制台不可达时不能据旧日志认定游戏在线。

“打开观战客户端”通过配置的 `ObserverWorld`（默认 `mymc`）读取观战端状态。未启动时调用该 World 的启动接口；已有进程时恢复并切换到它的窗口。窗口按宿主返回的 PID 及其子进程查找，重复点击复用同一客户端。可米宿主启动后此按钮可用。

运行中更新用 `update.ps1`。它将新程序编译到版本目录，只更新两个按需任务的程序路径，当前直播进程继续运行。关闭并重新打开控制面板后使用新按钮。原入口仍通过按需任务打开当前版本；任务旧定义保存在该版本目录的 `tasks-before.json`，可用于回退。安装新实例使用 `install.ps1`。

本机设置在安装目录 `settings.json`，日志在 `logs/`。不改 Cortico 官方源码、部署配置、模型或 World 选择。安装时用 `-NodeSource` 提供现役兼容 Node，复制到独立的 `runtime/` 并检查模块接口；不再依赖 Codex 的缓存路径。任务只使用当前登录用户，不保存登录密码。

需要向宿主及游戏子进程提供部署文件中的凭据时，可将 `Entry` 指向安装副本的 `bootstrap.mjs`。同目录 `bootstrap.json` 显式指定绝对 `entry`、`envFile` 及 `environmentKeys` 名单；只将名单中的变量交给原入口，其他变量不导入，凭据不写入日志。`entry` 保留原 CLI 入口，参数仍由 App 传递。此配置在下次启动生效，不能用于未经授权的重载。离线检查：`node --test test-bootstrap.mjs`。

测试用独立假宿主验证启动方退出、重复启动和正常关机；真实游戏恢复另行核对原会话、目标、记忆、实际登录与动作回执。关闭 Codex 的实机验收由操作员完成，不能用启动成功代替。

可选 `bootstrap.json.refreshPrefixOnStartup` 填本机控制台根地址。入口就绪后经官方接口在安全边界刷新 Persona 固定前缀，保留既有对话；它不暂停或恢复循环。与 `bootstrap.mjs` 一同安装 `startup-prefix.mjs`。接口超时只报告未确认，不重试已提交的前缀操作。检查：`node --test test-bootstrap.mjs test-startup-prefix.mjs`。

卸载时先从面板停止直播，再删除精确的 `Cormy.Live` 与 `Cormy.Live.Panel` 任务、两个快捷方式和安装目录；不删除 Cortico 部署。

可选在播音外壳旁放置 `audio-host.json`，声明 `speechFloor.node` 与 `speechFloor.guardian` 的已安装绝对路径。外壳先启动仅跟随自己 PID 的依赖守护并检查协调器就绪，再打开原桌宠媒体页。守护按需补起缺失的本机协调服务，不依赖“四个 Agent 都运行”，也不重启宿主或放行未经许可的声音。部署时须一并安装 `audio-dependency.cjs`；不配置该文件时沿用原行为。当前实例可单独挂接守护，无需中断游戏或正在运行的播音外壳。检查：`node --test test-audio-host.mjs test-audio-dependency.mjs test-bootstrap.mjs test-startup-prefix.mjs`。
