import type { OutputItem, StreamEvent } from '../protocol/open-responses/index.ts';

/** Projects executable call streams to a tap while retaining event order and stable item IDs. */
export class OutputTapGate {
  private readonly items = new Map<number, { item: OutputItem; closed: boolean }>();
  private readonly allowed = new Map<number, boolean>();
  private readonly indices = new Map<number, number>();
  private pending: StreamEvent[] = [];

  constructor(
    private readonly barrierAfter: (name: string) => boolean,
    private readonly excluded: (name: string) => boolean,
    private readonly emit: (event: StreamEvent) => void,
  ) {}

  onEvent(event: StreamEvent): void {
    if (event.type === 'response.created') {
      this.items.clear();
      this.allowed.clear();
      this.indices.clear();
      this.pending = [];
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (event.item) this.items.set(event.output_index, { item: event.item, closed: event.type === 'response.output_item.done' });
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      event.response.output.forEach((item, index) => this.items.set(index, { item, closed: true }));
    }
    this.pending.push(event);
    this.drain();
  }

  private permits(index: number): boolean | undefined {
    if (this.allowed.has(index)) return this.allowed.get(index);
    const state = this.items.get(index);
    if (!state) return undefined;
    if (state.item.type !== 'function_call') return true;
    if (this.excluded(state.item.name)) return false;
    for (let before = 0; before < index; before++) {
      const previous = this.items.get(before);
      if (!previous) return undefined;
      if (previous.item.type !== 'function_call' || this.excluded(previous.item.name)) continue;
      if (this.barrierAfter(previous.item.name)) return false;
      // A later call cannot externalize before an earlier call's completion is known.
      if (!previous.closed) return undefined;
      if (previous.item.status !== 'completed') return false;
    }
    return !state.closed || state.item.status === 'completed';
  }

  private drain(): void {
    let consumed = 0;
    for (const event of this.pending) {
      if ('output_index' in event) {
        const allowed = this.permits(event.output_index);
        if (allowed === undefined) break;
        this.allowed.set(event.output_index, allowed);
        consumed++;
        if (!allowed) continue;
        if (!this.indices.has(event.output_index)) this.indices.set(event.output_index, this.indices.size);
        this.emit({ ...event, output_index: this.indices.get(event.output_index)! });
      } else if ('response' in event) {
        const output = [...this.indices.entries()].sort((a, b) => a[1] - b[1])
          .flatMap(([index]) => event.response.output[index] ? [event.response.output[index]] : []);
        consumed++;
        this.emit({ ...event, response: { ...event.response, output } });
      } else {
        consumed++;
        this.emit(event);
      }
    }
    this.pending = this.pending.slice(consumed);
  }
}
