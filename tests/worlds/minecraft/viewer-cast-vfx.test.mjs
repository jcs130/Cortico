import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../../scripts/minecraft-viewer-cast.js', import.meta.url), 'utf8');

function loadVfx() {
  let now = 10_000;
  let disposed = 0;
  class Object3D {
    constructor() {
      this.children = [];
      this.position = { set() {} };
      this.scale = { setScalar() {}, set() {}, y: 1 };
      this.rotation = { set() {}, x: 0, y: 0, z: 0 };
      this.quaternion = { setFromUnitVectors() {} };
    }
    add(child) { this.children.push(child); child.parent = this; }
    remove(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
  }
  class Geometry {
    dispose() { disposed++; }
  }
  class Drawable extends Object3D {
    constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
  }
  class BufferGeometry extends Geometry {
    constructor() { super(); this.attributes = {}; }
    setAttribute(name, attr) { this.attributes[name] = attr; }
  }
  class BufferAttribute {
    constructor(array, size) { this.array = array; this.count = array.length / size; }
    setXYZ(index, x, y, z) { this.array.set([x, y, z], index * 3); }
  }
  class Material {
    dispose() { disposed++; }
  }
  class Color {
    constructor(hex) { this.r = (hex >> 16 & 255) / 255; this.g = (hex >> 8 & 255) / 255; this.b = (hex & 255) / 255; }
  }
  class Vector3 {
    constructor(x, y, z) { Object.assign(this, { x, y, z }); }
    normalize() { return this; }
  }
  const three = {
    Group: Object3D, Mesh: Drawable, Points: Drawable, LineSegments: Drawable,
    TorusGeometry: Geometry, CylinderGeometry: Geometry, BufferGeometry, BufferAttribute,
    MeshBasicMaterial: Material, PointsMaterial: Material, LineBasicMaterial: Material, Color, Vector3,
    AdditiveBlending: 1, DoubleSide: 2,
  };
  const scene = new Object3D();
  const context = vm.createContext({
    globalThis: { THREE: three, world: { scene, sceneOrigin: {
      toSceneX: (value) => value, toSceneY: (value) => value, toSceneZ: (value) => value,
    } } },
    document: { getElementById: () => null }, socket: {},
    pendingAvatarState: { entity: { pos: { x: 1, y: 70, z: 2 } } },
    latestPosition: { yaw: 0, pos: { x: 1, y: 70, z: 2 } },
    performance: { now: () => now }, requestAnimationFrame() {},
  });
  vm.runInContext(`${source}\nglobalThis.testVfx = {
    visual: cortiSpellVisual, start: cortiStartSkillEffect, animate: cortiAnimateSkillEffects,
    effects: cortiSkillEffects, setDimension: (value) => { cortiCastDimension = value; },
  };`, context);
  return { vfx: context.globalThis.testVfx, scene, setNow: (value) => { now = value; }, get disposed() { return disposed; } };
}

test('skill families have distinct visual motions and bounded particle counts', () => {
  const { vfx } = loadVfx();
  assert.equal(vfx.visual('frostnova').motion, 'nova');
  assert.equal(vfx.visual('flamewave').motion, 'wave');
  assert.equal(vfx.visual('starbolt').motion, 'bolt');
  assert.equal(vfx.visual('selfheal').motion, 'heal');
  assert.equal(vfx.visual('home').motion, 'portal');
  assert.equal(vfx.visual('golem').motion, 'summon');
  assert.equal(vfx.visual('fireworks').motion, 'burst');
  assert.equal(vfx.visual('starlight').motion, 'shower');
});

test('failed casts do not show success effects; success replaces the short wind-up', () => {
  const { vfx } = loadVfx();
  vfx.start({ spellId: 'frostnova', phase: 'sent' });
  assert.equal(vfx.effects.length, 1);
  assert.equal(vfx.effects[0].pointGeometry.attributes.position.count, 20);
  vfx.start({ spellId: 'frostnova', phase: 'failed' });
  assert.equal(vfx.effects.length, 1);
  vfx.start({ spellId: 'frostnova', phase: 'succeeded' });
  assert.equal(vfx.effects.length, 1);
  assert.equal(vfx.effects[0].pointGeometry.attributes.position.count, 84);
});

test('repeated casts stay bounded and expired geometry is disposed', () => {
  const run = loadVfx();
  for (let i = 0; i < 12; i++) {
    run.setNow(10_000 + i * 5);
    run.vfx.start({ spellId: `spell${i}`, phase: 'succeeded' });
  }
  assert.equal(run.vfx.effects.length, 6);
  assert.ok(run.disposed >= 24);
  run.vfx.animate(12_000);
  assert.equal(run.vfx.effects.length, 0);
  assert.equal(run.scene.children.length, 0);
});

test('precise server target replaces a guessed success effect without doubling it', () => {
  const { vfx, setNow } = loadVfx();
  vfx.start({ spellId: 'starbolt', phase: 'succeeded' });
  setNow(10_150);
  vfx.start({ spellId: 'goddess:starbolt', phase: 'succeeded', position: { x: 5, y: 71, z: 6 } });
  assert.equal(vfx.effects.length, 1);
  assert.equal(vfx.effects[0].reach, Math.hypot(4, 4));
  setNow(10_180);
  vfx.start({ spellId: 'starbolt', phase: 'succeeded' });
  assert.equal(vfx.effects.length, 1);
});

test('server positions only create effects in the current dimension', () => {
  const { vfx } = loadVfx();
  vfx.setDimension('minecraft:overworld');
  vfx.start({ spellId: 'starbolt', phase: 'succeeded', dimension: 'minecraft:the_nether',
    position: { x: 5, y: 71, z: 6 } });
  assert.equal(vfx.effects.length, 0);
  vfx.start({ spellId: 'starbolt', phase: 'succeeded', dimension: 'minecraft:overworld',
    position: { x: 5, y: 71, z: 6 } });
  assert.equal(vfx.effects.length, 1);
});

test('authoritative skill event fills the on-screen cast name and result', () => {
  const listeners = new Map();
  const phase = { textContent: '' }, name = { textContent: '' }, detail = { textContent: '' };
  const line = { style: {}, offsetWidth: 0 };
  const root = { hidden: true, dataset: {}, querySelector(selector) {
    return { '[data-cast-phase]': phase, '[data-cast-name]': name,
      '[data-cast-detail]': detail, '.corti-cast-line': line }[selector];
  } };
  const context = vm.createContext({
    globalThis: {},
    document: { getElementById: () => root },
    socket: { on: (event, callback) => listeners.set(event, callback) },
    pendingAvatarState: null, latestPosition: null,
    performance: { now: () => 10_000 }, requestAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(source, context);
  listeners.get('biome')({ dimension: 'minecraft:overworld' });
  listeners.get('castCue')({ seq: 1, phase: 'succeeded', spellId: 'starbolt',
    spellName: '星芒箭', detail: '命中 僵尸', tone: 'arcane',
    dimension: 'minecraft:overworld', position: { x: -589.5, y: 92.62, z: -326.15 } });
  assert.equal(root.hidden, false);
  assert.equal(phase.textContent, '✦ 使用技能 · 生效');
  assert.equal(name.textContent, '星芒箭');
  assert.equal(detail.textContent, '命中 僵尸');
  assert.equal(root.dataset.tone, 'arcane');
  listeners.get('castCue')({ seq: 2, phase: 'succeeded', spellId: 'home',
    spellName: '归乡', detail: '传送完成', tone: 'movement',
    dimension: 'minecraft:overworld', position: { x: -543.5, y: 67, z: -439.5 } });
  assert.equal(root.hidden, false);
  assert.equal(name.textContent, '归乡');
  assert.equal(detail.textContent, '传送完成');
  assert.equal(root.dataset.tone, 'movement');
});
