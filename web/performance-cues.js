/** Playback-bound presentation metadata. Manual body controls retain priority. */
export class PerformanceCues {
  constructor(receipt) {
    this.receipt = receipt;
    this.pending = null;
    this.active = null;
    this.weights = {};
  }
  receive(command) {
    this.pending = command;
  }
  cancel(eventId) {
    if (this.pending?.eventId === eventId) this.pending = null;
    if (this.active?.eventId === eventId) {
      this.active.stopGesture?.();
      this.active = null;
    }
  }
  reset() {
    this.active?.stopGesture?.();
    this.pending = null;
    this.active = null;
    this.weights = {};
  }
  update(audio, dt, { busy, play, isLoop } = {}) {
    if (
      this.active &&
      (!audio.playing || audio.actionId !== this.active.audioActionId)
    ) {
      this.active.stopGesture?.();
      this.receipt("ended", this.active.eventId);
      this.active = null;
    }
    if (this.pending && this.pending.expiresAt < Date.now()) {
      this.receipt(
        "failed",
        this.pending.eventId,
        "Presentation audio did not start in time",
      );
      this.pending = null;
    }
    if (
      this.pending &&
      audio.playing &&
      audio.actionId === this.pending.audioActionId
    ) {
      this.active = this.pending;
      this.pending = null;
      this.receipt("playing", this.active.eventId);
    }
    const row = this.active;
    if (row?.bodyClip && !row.gestureApplied && !busy) {
      if (!isLoop?.(row.bodyClip)) row.stopGesture = play?.(row.bodyClip);
      row.gestureApplied = true;
    }
    const target = row?.expressionWeights ?? {},
      alpha = 1 - Math.exp(-Math.max(0, dt) / 0.25);
    for (const key of new Set([
      ...Object.keys(this.weights),
      ...Object.keys(target),
    ]))
      this.weights[key] =
        (this.weights[key] ?? 0) +
        ((target[key] ?? 0) - (this.weights[key] ?? 0)) * alpha;
    for(const key of Object.keys(this.weights))
      if(!(key in target) && Math.abs(this.weights[key])<.001)delete this.weights[key];
    return {
      weights: this.weights,
      loopClip:
        row?.bodyClip && isLoop?.(row.bodyClip) ? row.bodyClip : undefined,
      cueId: row?.eventId ?? null,
    };
  }
}
