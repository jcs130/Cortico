import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { observeViewerBossBars } from '../../../src/worlds/minecraft/viewer-boss-bars.ts';

describe('Minecraft viewer boss bar updates', () => {
  it('publishes the list after Mineflayer removes a deleted skill bar', async () => {
    const bot = new EventEmitter();
    const bars = [{ title: '采矿经验' }];
    const published: string[][] = [];
    const stop = observeViewerBossBars(bot, () => published.push(bars.map(bar => bar.title)));
    bot.emit('bossBarCreated', bars[0]);
    bot.emit('bossBarDeleted', bars[0]);
    bars.pop(); // Mineflayer deletes from bot.bossBars after emitting.
    await Promise.resolve();
    expect(published).toEqual([['采矿经验'], []]);
    stop();
    bot.emit('bossBarCreated', { title: '另一个' });
    expect(published).toHaveLength(2);
  });
});
