<!-- Owner: main.cjs and pet.html -->
# 可米桌面显示

复用官方 `cortico-world-desktop-pet` 的 Electron 透明窗口，内嵌当前演出室的透明播出页面。显示同一份私有模型和实时动作，不启动模型推理、TTS、游戏或另一份 Persona。

这是现役演出室的桌面显示入口。完整 desktop-pet World 的工具、聊天和语音迁移仍使用独立候选，不由这个入口加载。透明页面默认不抢占现有音频播放器。

窗口默认出现在主屏右下方；拖动人物可移动，悬停后可隐藏。系统托盘可以重新显示或退出。按需任务 `Cormy.Desktop` 没有开机触发器或故障自动重启。

安装目录中的 `settings.json` 指定 `stageUrl`、状态端口和应用数据目录。`official/host`、`official/web/i18n` 及许可文件从已验证的官方桌宠候选复制；窗口宿主保持原样。
