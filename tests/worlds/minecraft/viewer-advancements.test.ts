import { describe, expect, it } from 'vitest';
import { ViewerAdvancementTracker } from '../../../src/worlds/minecraft/viewer-advancements.ts';

const definition = { key: 'server:first_trial', value: {
  displayData: { title: { text: '初试锋芒' }, description: { text: '通过第一层' },
    frameType: 1, flags: { show_toast: 1 } }, requirements: [['trial']],
} };
const text = (value: unknown) => (value as { text: string }).text;

describe('advancement completion', () => {
  it('shows only a new completed advancement with toast enabled', () => {
    const tracker = new ViewerAdvancementTracker();
    expect(tracker.ingest({ reset: true, advancementMapping: [definition], progressMapping: [] }, text)).toEqual([]);
    const progress = { key: definition.key, value: [{ criterionIdentifier: 'trial', criterionProgress: 1 }] };
    expect(tracker.ingest({ progressMapping: [progress] }, text))
      .toEqual([{ key: definition.key, title: '初试锋芒', description: '通过第一层', frame: 'goal' }]);
    expect(tracker.ingest({ progressMapping: [progress] }, text)).toEqual([]);
  });

  it('does not replay completed history on initial sync', () => {
    const tracker = new ViewerAdvancementTracker();
    expect(tracker.ingest({ reset: true, advancementMapping: [definition], progressMapping: [
      { key: definition.key, value: [{ criterionIdentifier: 'trial', criterionProgress: 1 }] },
    ] }, text)).toEqual([]);
  });
});
