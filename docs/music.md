<!-- Owner: ../src/core/music.ts, ../src/desktop-audio.ts -->
# 音乐服务接入

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
