import { describe, expect, it } from 'vitest';
import { repairDoorWaypoints } from '../../../src/worlds/minecraft/path-waypoints.ts';

function fakeDoor(open: boolean) {
  return {
    blockAt: () => ({
      name: 'spruce_door', position: { x: -571, y: 68, z: -480 },
      getProperties: () => ({ half: 'lower', open }),
    }),
  } as never;
}

describe('寻路节点中的门顶错位', () => {
  it('将打开的门顶节点还原为门洞中心', () => {
    const path = [{ x: -570.296875, y: 69, z: -479.5, toPlace: [] }];
    expect(repairDoorWaypoints(fakeDoor(true), path)).toBe(1);
    expect(path[0]).toMatchObject({ x: -570.5, y: 68, z: -479.5 });
  });

  it('关门从平行方向穿过时也还原门洞中心；待交互节点不改', () => {
    const path = [{ x: -570.296875, y: 69, z: -479.5, toPlace: [] }];
    expect(repairDoorWaypoints(fakeDoor(false), path)).toBe(1);
    expect(path[0]).toMatchObject({ x: -570.5, y: 68, z: -479.5 });
    expect(repairDoorWaypoints(fakeDoor(true), [{ ...path[0], toPlace: [{ useOne: true }] }])).toBe(0);
  });

  it('还原现场关着的云杉门被抬高且偏向门板的落点', () => {
    const path = [{ x: -570.5, y: 69, z: -479.296875, toPlace: [] }];
    expect(repairDoorWaypoints(fakeDoor(false), path)).toBe(1);
    expect(path[0]).toMatchObject({ x: -570.5, y: 68, z: -479.5 });
  });
});
