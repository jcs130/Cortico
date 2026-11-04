# Game voice and audience voice

Audience commentary continues through `avatar_voice speak`: configured streaming TTS, avatar mouth/gesture, current broadcast ownership and actual renderer receipts. It is not sent to the game.

An explicitly configured game World can use `/api/voice-artifacts` to synthesize one complete line with the **current selected voice**, without an avatar renderer, local speaker, speech-floor lease or interruption of audience audio. The synthesis service shares its serial inference queue; it does not introduce a second provider or split a line into independent clones. Native drama-rs completion remains unknown.

`POST /api/voice-artifacts {requestId,text}` returns finite PCM16 WAV plus artifact/hash/completion headers. Maximum 4MiB/30s; overlong audio fails instead of silently clipping or independently re-cloning pieces. UUIDs are durable: the same ID cannot change text, completed synthesis is reused, and interrupted synthesis is never automatically replayed.

In live-and-game mode the game World uploads that WAV and separately calls `POST /api/voice-artifacts/{requestId}/broadcast {}`. Stage reuses the **stored WAV**, goes through its usual broadcast admission and audio renderer (including any configured shared floor), and returns a distinct action ID. The game channel bypasses the broadcast floor; the broadcast channel does not. A queued/accepted mirror is not audible playback. `GET /api/actions/{id}` supplies actual renderer status.

For an existing `audio/wav` blob, `PUT /api/voice-artifacts/{requestId}` imports bytes without synthesis before mirroring. The endpoints are local, retain the existing Host/Origin checks, do not accept provider/voice credentials, and do not automatically forward captions, private messages or audience commentary. Ordinary live streaming remains unchanged; the game protocol requires a full WAV hash before upload.
