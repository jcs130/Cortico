# 可米本地 Drama3

`bridge.mjs` 通过独立 Windows 按需任务运行 audio.cpp 的 Drama3 原生后端，将 SSE PCM 包转为演出 World 可用的 44.1 kHz PCM WAV。模型、参考音频和配置放在私有部署目录，不随源码或公共 World 打包。Built with Fish Audio；权重沿用 Fish Audio Community License。

启动：`node bridge.mjs <绝对 config.json>`，或安装后的 `Cormy.Drama3` 按需任务。脚本只监听 `127.0.0.1`。无开机触发器、无异常自动重启、无云端回退。直播期间保持预热，不按一分钟闲置自动释放模型。启动入口应确认 `/health` 的 `ready:true` 后再接收直播语音。

配置字段：`port`、`nativePort`、`executable`、`cudaDir`、`modelFile`、`referenceWav`、`referenceText`、`dataDir`、`model`、`voice`；可选 `cpuExpertLayers`、`threads`、`warmOnStart`、`retainLatestAudio`。路径必须绝对；权重和参考音频只读。服务仅接受配置的模型/音色，不把任意文件路径交给调用者。

接口：GET `/health`、`/metrics`、`/v1/audio/voices`，POST `/warm`、`/v1/audio/speech`。语音请求使用 `model`、`voice`、`input`。方括号演绎提示原样交给 Drama3，不进行第二次 LLM 改写。最新音频与最近 300 条时间、正文、首包、总耗时记录只保留在私有服务目录；不要收进公开包。

此网关保留单任务准入，取消会中止 HTTP 和待播数据；原生移植端是否立即停止 GPU 计算仍取决于其取消实现，不能把 HTTP 已关当作 GPU 已停止。服务故障会明确失败，维护者据日志恢复，不靠无证据重发台词。

可选显存策略：`diskExperts:true`、`expertCacheSize:8..256`、`pinExperts:true`（默认全部不开启；原生默认缓存 32 槽）。这是 audio.cpp 已有的专家缓存机制，模型和参考音频不变。缓存大小是每层槽位数，不能当作进程峰值显存。先在独立端口测量冷启动、首包、完整合成、进程显存和共存负载，再决定部署；不把更小缓存直接称为更快。

2026-10-21 实测：Q4、4 个 CPU expert layers、Q5 参考音频；冷预热约 23 秒。独立候选中的带提示短台词完成，6.27 秒音频，浏览器首声 0.83 秒、0 underruns；这是热模型短样本，不能推广成长期延迟保证。
