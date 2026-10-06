import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const root = process.cwd();

class Transform {
  set(x, y, z) { this.x = x; this.y = y; this.z = z; }
}

class Object3D {
  constructor(name = '') {
    this.name = name;
    this.children = [];
    this.parent = null;
    this.position = new Transform();
    this.rotation = new Transform();
    this.visible = true;
  }
  add(child) {
    child.removeFromParent();
    this.children.push(child);
    child.parent = this;
  }
  removeFromParent() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  getObjectByName(name) {
    if (this.name === name) return this;
    for (const child of this.children) {
      const found = child.getObjectByName(name);
      if (found) return found;
    }
    return null;
  }
  getWorldScale(vector) { vector.set(1 / 16, 1 / 16, 1 / 16); return vector; }
}

function scriptContext(file) {
  const context = vm.createContext({
    socket: { on() {} },
    requestAnimationFrame() {},
    THREE: {
      Vector3: class extends Transform {},
      Group: Object3D,
      Mesh: class extends Object3D {
        constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
      },
      CylinderGeometry: class {}, ConeGeometry: class {}, PlaneGeometry: class {},
      MeshStandardMaterial: class {}, MeshBasicMaterial: class {}, DoubleSide: 2,
    },
  });
  vm.runInContext(readFileSync(join(root, 'scripts', file), 'utf8'), context);
  return context;
}

test('non-player equipment stays on the correct wrists after renderer attachment', () => {
  const context = scriptContext('minecraft-viewer-entity-motion.js');
  const model = new Object3D('model');
  const rightArm = new Object3D('bone_rightArm');
  const leftArm = new Object3D('bone_leftArm');
  const main = new Object3D('custom_item_left');
  const off = new Object3D('custom_item_right');
  model.add(rightArm);
  model.add(leftArm);
  leftArm.add(main);
  rightArm.add(off);
  context.model = model;
  context.motion = { parts: new Map([
    ['rightarm', [{ object: rightArm }]], ['leftarm', [{ object: leftArm }]],
  ]) };
  vm.runInContext("cortiAttachMobNativeItem(model, motion, 0, 'right'); cortiAttachMobNativeItem(model, motion, 1, 'left')", context);
  assert.equal(main.parent, rightArm);
  assert.equal(off.parent, leftArm);
  assert.ok(main.position.y < -9 && main.position.y > -10);
  assert.ok(off.position.y < -9 && off.position.y > -10);
  // A subsequent render frame must not duplicate either mesh.
  vm.runInContext("cortiAttachMobNativeItem(model, motion, 0, 'right'); cortiAttachMobNativeItem(model, motion, 1, 'left')", context);
  assert.equal(rightArm.children.filter(child => child === main).length, 1);
  assert.equal(leftArm.children.filter(child => child === off).length, 1);
});

test('main-hand bow moves to the left and shows a nocked arrow only while drawing', () => {
  const context = scriptContext('minecraft-viewer-weapon-motion.js');
  const holding = { cameraGroup: new Object3D('camera') };
  context.holding = holding;
  context.use = { kind: 'bow', hand: 'right', phase: 'draw', at: 1000 };
  const pose = vm.runInContext('cortiRangedPoseAt(use, 1900)', context);
  assert.ok(pose.x < -0.8);
  vm.runInContext('cortiUpdateDrawnArrow(holding, use, 1900)', context);
  const arrow = holding.cortiNockedArrow;
  assert.equal(arrow.name, 'corti-nocked-arrow');
  assert.equal(arrow.parent, holding.cameraGroup);
  assert.equal(arrow.visible, true);
  assert.equal(arrow.children.length, 4);
  context.use.phase = 'release';
  vm.runInContext('cortiUpdateDrawnArrow(holding, use, 1910)', context);
  assert.equal(arrow.visible, false);
});
