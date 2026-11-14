<!-- Owner: ../src/core/music.ts, ../src/desktop-audio.ts -->
# 音乐服务接入

音乐已由当前播音设备确认在统一音频队列中等待时，沿用配置的 `voice.rendererStartTimeoutMs` 等待开播。队列位置变化不重置期限；掉线或从未取得等待回执的命令仍按短超时失败。实际 `playing` 和 `ended` 回执仍分别确认开播与结束。

歌曲既可以由演出室页面播放，也可以通过显式的 `presentation.mode:desktop-audio` 使用桌宠音频设备。两者复用同一曲库、原 action 回执、采用状态、人声包络及歌词。桌宠音频设备不渲染演出室的骨骼指令；它只报告实际音频播放，桌面形象使用自己的动作词表。

曲库配置 `music.directory`。目录中的 `catalog.json`：

```json
{
  "version": 1,
  "tracks": [
    {
      "id": "original-001",
      "title": "原创试听",
      "wavFile": "original-001.wav",
      "vocalFile": "original-001-vocal.wav",
      "lyricsFile": "original-001-lyrics.json",
      "instrumental": false,
      "aiGenerated": true,
      "contentApproved": true,
      "audioValidated": true
    }
  ]
}
```

所有文件必须位于配置的曲库内，拒绝路径逃逸。支持 PCM16/24/32 和浮点 WAV。人声文件用于口型包络；没有人声文件时可用有时间戳的歌词：

```json
{ "version": 1, "lines": [{ "atMs": 0, "endMs": 1500, "text": "第一句歌词" }] }
```

纯器乐不动嘴；没有人声包络或歌词时也不把伴奏响度当成口型。播放使用真实浏览器音频时钟。TTS 音色选择不会改变歌曲里已录制的演唱者；当前没有声线转换或已验证的“同一歌唱声线”承诺。

## 创作与导入

歌曲生成迁到 cortico-world-aigc 的 aigc_create kind:music。旧 generate 返回 capability_moved；旧任务记录与曲库继续可读。演出室不再提交、轮询或取消云端生成任务。旧 cloud-music 只读取原归档并保留本地试听／采用。

从 Core 收到成品 audio/wav 句柄后，调用 avatar_music action:import，提供 reference_handle、title 与 instrumental。导入返回 review 候选，不自动加入播出库或播放；用 preview 实际试听，然后 approve/reject，再显式 play。import 的 hash、采用状态与文件持久保存。没有人声轨或时间戳的新增混音仍不假装具有可用口型。

独立 SDK 使用 client.importMusic(bytes, metadata)；服务端提供有界 audio/wav 二进制入口，普通 JSON 限额不变，Host/Origin 校验保留。不会通过用户提供的 URL、磁盘路径或其他 World 的私有接口拉取成品。

## 按需发现与自主选择

宿主可把本页接入自己的按需资料目录，保留一个简短音乐入口。曲目和歌词由查询展开，不把整套曲库常驻在系统提示中。已有音乐活动已经结束不代表能力被撤销，也不需要复活旧日程或固定间隔强制唱歌。

演唱现有作品先 `avatar_query {"action":"music"}`，从最新返回的真实 ID 选择曲目，再 `avatar_music {"action":"play","trackId":"<id>"}`。`instrumental:false` 表示有人声；播放器可用和曲库已配置仍须分别核实。点歌、休息、庆祝是否合适由人格结合当前活动选择，普通 TTS 念歌词不等于唱歌。

创作新歌先读 `aigc_query {"action":"capabilities"}` 与 `aigc_help {}`。当前生成契约为 `aigc_create` 的 `action:"generate"`、`kind:"music"`、`prompt` 与稳定 `request_id`；只使用服务声明过的 parameters。结果未知时查询原任务，不重复生成。完成后通过宿主 WAV 句柄导入、试听、采用，再显式播放。

记录原 action 的真实播放起止及失败原因。音频设备的成功不能证明三维动作已经显示；新歌曲生成也不能自动证明歌唱音色与当前口播相同。检索到指南不代表人格已经采用它或学会了新的演出方法。
# Proactive singing

`autoMusic.enabled` opts into timer-driven playback of approved, validated vocal tracks already installed in the library. It does not generate or clone songs. Defaults: continuous travel 90 seconds, idle 120 seconds, minimum 300 seconds between songs. Instrumentals are excluded and the next eligible track rotates after the last one.

Supporting hosts call `publishPerformanceActivity({source, observedAt, mode, activityId})` with fresh structured facts. Modes are `travel`, `idle`, `busy`, `unavailable`. Missing/stale facts, paused host, combat/emergency activity, missing playback device, active/pending local speech or music postpone admission. Recheck `audioRevision` after asynchronous work prevents a song from replacing a new dialogue. The playback ledger retains the last music action across reload; queue/playing is not proof of completion. Existing received-game-voice ducking remains the renderer's responsibility.

This optional timer never acquires game body control or waits for a model turn to end. Disable `autoMusic.enabled` to turn it off. A stopped or completed song starts the cooldown; it is not immediately restarted.
