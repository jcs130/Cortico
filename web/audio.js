import { playSpeech } from "./speech.js";
export class AudioOutput {
  constructor({ sessionId, receipt, onMouth, onLyric, onState }) {
    Object.assign(this, { sessionId, receipt, onMouth, onLyric, onState });
    this.context = null;
    this.abort = null;
    this.music = null;
    this.current = null;
    this.speechPlaying = false;
    this.musicPlaying = false;
    this.level = 0;
    this.cues = null;
    this.stats = null;
    this.epoch = 0;
  }
  unlock() {
    // Run directly in the click handler. Registration/network work must never
    // precede resume(), otherwise browsers can lose the user activation.
    this.context ??= new AudioContext();
    const resume = this.context.resume();
    this.onState("正在开启声音…");
    let timer;
    return Promise.race([
      resume.then(() => {
        if (this.context.state !== "running")
          throw Error("浏览器暂停了声音，请点击“开启声音”");
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("浏览器未允许播放，请点击“开启声音”")),
          3000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }
  async enable(prepare) {
    const unlocked = this.unlock();
    // Attach both promises immediately, including when preparation fails.
    await Promise.all([unlocked, prepare?.()]);
    const r = await fetch("/api/audio-owner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId }),
    });
    const j = await r.json();
    if (!r.ok) throw Error(j.error);
    this.onState("本页已取得音频输出");
    return j;
  }
  stop() {
    this.epoch++;
    this.abort?.abort();
    this.abort = null;
    if (this.music) {
      this.music.pause();
      this.music.src = "";
      this.music = null;
    }
    this.current = null;
    this.speechPlaying = false;
    this.musicPlaying = false;
    this.cues = null;
    this.level = 0;
    this.onMouth(0);
    this.onLyric("");
  }
  async command(command) {
    if (command.targetSession !== this.sessionId) return;
    this.stop();
    if (!this.context || this.context.state !== "running")
      throw Error("Enable browser audio first");
    const epoch = this.epoch;
    this.current = command.eventId;
    const url = new URL(command.url, location.href);
    url.searchParams.set("sessionId", this.sessionId);
    if (command.kind === "speech") {
      this.abort = new AbortController();
      const abort = this.abort;
      await playSpeech({
        url: url.href,
        context: this.context,
        signal: this.abort.signal,
        prebufferMs: command.prebufferMs,
        onStart: () => {
          if (epoch === this.epoch) {
            this.speechPlaying = true;
            this.receipt("playing", command.eventId);
          }
        },
        onEnd: () => {
          if (epoch === this.epoch) {
            this.receipt("ended", command.eventId);
            this.speechPlaying = false;
            this.current = null;
          }
        },
        onLevel: (v) => {
          if (epoch === this.epoch) this.level = v;
        },
        onStats: (stats) => {
          this.stats = { ...stats, actionId: command.eventId };
          document.body.dataset.audioStats = JSON.stringify(this.stats);
        },
      }).catch(async (error) => {
        if (epoch !== this.epoch || abort.signal.aborted) return;
        // Closing the provider HTTP stream can beat the cancellation SSE event.
        // Reconcile the original action once before displaying a network failure.
        let action;
        try {
          const response = await fetch(
            "/api/actions/" + encodeURIComponent(command.eventId),
          );
          if (response.ok) action = await response.json();
        } catch {}
        if (epoch !== this.epoch || abort.signal.aborted) return;
        if (action?.status === "cancelled") {
          this.stop();
          this.onState("播放已打断");
          return;
        }
        throw error;
      });
      return;
    }
    const cues = new URL(command.cues, location.href);
    cues.searchParams.set("sessionId", this.sessionId);
    const response = await fetch(cues);
    if (!response.ok) throw Error("Song cues unavailable");
    this.cues = await response.json();
    if (epoch !== this.epoch) return;
    const audio = new Audio(url.href);
    this.music = audio;
    audio.volume = command.volume ?? 0.65;
    audio.onplaying = () => {
      if (epoch === this.epoch) {
        this.musicPlaying = true;
        this.receipt("playing", command.eventId);
      }
    };
    audio.onended = () => {
      if (epoch === this.epoch) {
        this.receipt("ended", command.eventId);
        this.stop();
      }
    };
    audio.onerror = () => {
      if (epoch === this.epoch) {
        this.receipt("failed", command.eventId, "Music playback failed");
        this.stop();
      }
    };
    await audio.play();
  }
  update() {
    let mouth = this.level;
    if (this.music && this.cues) {
      const at = this.music.currentTime * 1000,
        line = this.cues.lyrics?.find((l) => at >= l.atMs && at < l.endMs);
      this.onLyric(line?.text ?? "");
      if (this.cues.envelope)
        mouth =
          this.cues.envelope.samples[
            Math.floor(at / this.cues.envelope.stepMs)
          ] ?? 0;
      else
        mouth = line?.text?.trim()
          ? Math.max(0, 0.22 + 0.14 * Math.sin(at * 0.025))
          : 0;
    }
    this.onMouth(mouth);
    return {
      playing:
        this.speechPlaying ||
        (this.musicPlaying && !this.music?.paused && !this.music?.ended),
      actionId: this.current,
      kind: this.speechPlaying
        ? "speaking"
        : this.musicPlaying && !this.music?.paused && !this.music?.ended
          ? "singing"
          : "idle",
      singing:
        this.musicPlaying &&
        !this.music?.paused &&
        !this.music?.ended &&
        this.cues?.mouthSource !== "none",
      timeMs: (this.music?.currentTime ?? 0) * 1000,
    };
  }
}
