/** A keyed capture connection expires after a minute without a renewal. */
export class ViewerCaptureLease {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly expired: () => void, private readonly idleMs = 60_000) {
    this.renew();
  }

  renew(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.expired();
    }, this.idleMs);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
