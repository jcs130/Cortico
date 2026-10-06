import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve('scripts/minecraft-viewer-shield.js'), 'utf8');

class Group {
  name = '';
  children: unknown[] = [];
  position = { set: (...args: number[]) => { this.location = args; } };
  rotation = { y: 0, set: (...args: number[]) => { this.pose = args; } };
  scale = { setScalar: (value: number) => { this.size = value; } };
  location: number[] = [];
  pose: number[] = [];
  size = 1;
  add(child: unknown) { this.children.push(child); }
  remove(child: unknown) { this.children = this.children.filter(value => value !== child); }
  getObjectByName(name: string) { return this.children.find((child) => (child as { name?: string }).name === name); }
}

class Mesh extends Group {
  constructor(public geometry: unknown, public material: unknown) { super(); }
}

const three = { Group, Mesh, BoxGeometry: class {}, MeshStandardMaterial: class {} };

describe('viewer shield', () => {
  it('rests low at the side and moves inward only while blocking', () => {
    const { pose } = runInNewContext(`${source}\n({pose:cortiShieldPose})`, {
      globalThis: { THREE: three },
    }) as { pose: (raised: boolean) => { x: number; y: number; yaw: number; scale: number } };
    const idle = pose(false);
    const blocking = pose(true);
    expect(idle.x).toBeGreaterThan(blocking.x);
    expect(idle.y).toBeLessThan(blocking.y);
    expect(Math.abs(idle.yaw)).toBeGreaterThan(Math.abs(blocking.yaw));
    expect(idle.scale).toBeLessThan(blocking.scale);
  });
  it('uses a visible shield model for the first-person offhand', async () => {
    const native = async (_item: { name: string }) => ({ model: 'native' as unknown, type: 'item' });
    const offhand = { createItemModel: native, updateItem() {}, lastHeldItemRenderKey: 'old' as string | undefined };
    const { initialize } = runInNewContext(`${source}\n({initialize:cortiInitializeShield})`, {
      globalThis: { THREE: three, world: { holdingBlockLeft: offhand } },
    }) as { initialize: () => void };
    initialize();
    const shield = await offhand.createItemModel({ name: 'shield' });
    expect((shield.model as Group).name).toBe('corti-shield');
    expect((shield.model as Group).children).toHaveLength(5);
    expect(await offhand.createItemModel({ name: 'totem_of_undying' })).toEqual({ model: 'native', type: 'item' });
    expect(offhand.lastHeldItemRenderKey).toBeUndefined();
  });

  it('attaches to the left arm and disappears when the offhand changes', () => {
    const arm = new Group();
    const native = { name: 'custom_item_left', visible: true };
    const rendered = { playerObject: { skin: { leftArm: arm } }, getObjectByName: () => native };
    const { sync } = runInNewContext(`${source}\n({sync:cortiSyncAvatarShield})`, {
      globalThis: { THREE: three, world: { entities: { entities: { '7': rendered } } } },
      usesWorldAvatar: false,
    }) as { sync: (entity: { id: number }, item: { name: string } | null) => void };
    sync({ id: 7 }, { name: 'shield' });
    expect(arm.children).toHaveLength(1);
    expect(native.visible).toBe(false);
    sync({ id: 7 }, { name: 'shield' });
    expect(arm.children).toHaveLength(1);
    sync({ id: 7 }, null);
    expect(arm.children).toHaveLength(0);
    expect(native.visible).toBe(true);
  });
});
