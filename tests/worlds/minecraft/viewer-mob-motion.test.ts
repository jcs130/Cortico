import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { it } from 'vitest';

it('animates hostile mobs from equipment, metadata, and projectiles without separating OBJ parts', () => {
const requireViewer = createRequire(createRequire(import.meta.url).resolve('prismarine-viewer/package.json'));
const THREE = requireViewer('three');
const events = new Map<string, (event: unknown) => void>();
const entities = new Map<string, any>();
const scenes: Record<string, any> = {};
let frame: (now: number) => void = () => {};
let now = 0;
class TextureLoader {
  load(url: string) {
    const texture = new THREE.Texture();
    texture.userData = { url };
    return texture;
  }
}
const context: Record<string, any> = {
  THREE: { ...THREE, TextureLoader },
  socket: { on(name: string, listener: (event: unknown) => void) { events.set(name, listener); } },
  entityCache: entities,
  world: { entities: { entities: scenes } },
  cortiUpdateWorldEquipmentGlint() {},
  performance: { now: () => now },
  requestAnimationFrame(listener: (now: number) => void) { frame = listener; },
};
context.globalThis = context;
vm.runInNewContext(readFileSync('scripts/minecraft-viewer-entity-motion.js', 'utf8'), context);

function run(time: number) {
  now = time;
  frame(now);
}
function bone(model: any, name: string) {
  const part = new THREE.Bone();
  part.name = `bone_${name}`;
  model.add(part);
  return part;
}
const skeleton = new THREE.Group();
skeleton.name = 'mesh';
const rightArm = bone(skeleton, 'rightArm');
bone(skeleton, 'leftArm');
bone(skeleton, 'rightLeg');
bone(skeleton, 'leftLeg');
const skeletonScene = new THREE.Group();
skeletonScene.add(skeleton);
scenes['101'] = skeletonScene;
const metadata = [];
metadata[15] = 4;
entities.set('101', { id: 101, name: 'skeleton', pos: { x: 0, y: 0, z: 0 },
  metadata, equipment: [null], velocity: { x: .13, y: 0, z: 0 } });
run(0);
run(900);
const ranged = skeleton.userData.cortiMobMotion.ranged;
assert.ok(ranged.group.visible, 'skeleton bow is visible');
assert.match(ranged.material.map.userData.url, /bow_pulling_2\.png$/, 'aggressive skeleton draws bow');
assert.ok(rightArm.rotation.x > .5, 'skeleton arm raises to aim');
assert.ok(ranged.shaft.visible, 'nocked arrow appears during draw');

const arrowScene = new THREE.Group();
const nativeArrow = new THREE.Group();
nativeArrow.name = 'mesh';
arrowScene.add(nativeArrow);
scenes['102'] = arrowScene;
entities.set('102', { id: 102, name: 'arrow', pos: { x: 0.1, y: 1.3, z: 0.1 },
  velocity: { x: 0, y: 0, z: -1 } });
run(1000);
run(1016);
assert.match(ranged.material.map.userData.url, /bow\.png$/, 'nearby projectile releases bow');
assert.equal(ranged.shaft.visible, false, 'nocked arrow leaves bow');

const objModel = new THREE.Group();
const mesh = new THREE.Mesh(new THREE.BoxGeometry(.2, .8, .2).translate(.4, 1.1, 0));
mesh.name = 'RightArm';
objModel.add(mesh);
objModel.updateMatrixWorld(true);
const firstVertex = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, 0);
const before = mesh.localToWorld(firstVertex.clone());
const parts = context.cortiMobRig(objModel);
objModel.updateMatrixWorld(true);
const after = mesh.localToWorld(firstVertex.clone());
assert.ok(before.distanceTo(after) < 1e-8, 'OBJ limb keeps its position when pivot is added');
assert.equal(parts.get('rightarm')?.length, 1, 'OBJ limb receives an animation pivot');

const creeper = new THREE.Group();
creeper.name = 'mesh';
for (let i = 0; i < 4; i += 1) {
  const leg = new THREE.Mesh(new THREE.BoxGeometry(.1, .4, .1).translate(i * .1, .2, 0));
  leg.name = `leg${i}`;
  creeper.add(leg);
}
const creeperScene = new THREE.Group();
creeperScene.add(creeper);
scenes['103'] = creeperScene;
const creeperMetadata = [];
creeperMetadata[16] = 1;
entities.set('103', { id: 103, name: 'creeper', pos: { x: 4, y: 0, z: 0 },
  metadata: creeperMetadata, velocity: { x: .1, y: 0, z: 0 } });
run(1200);
assert.ok(creeper.scale.x > 1, 'creeper swells during fuse');
assert.ok(creeper.userData.cortiMobMotion.parts.get('leg0')[0].object.rotation.x !== 0,
  'creeper legs move while walking');

const pillager = new THREE.Group();
pillager.name = 'mesh';
bone(pillager, 'rightArm');
bone(pillager, 'leftArm');
const pillagerScene = new THREE.Group();
pillagerScene.add(pillager);
scenes['104'] = pillagerScene;
const pillagerMetadata = [];
pillagerMetadata[17] = true;
entities.set('104', { id: 104, name: 'pillager', pos: { x: 6, y: 0, z: 0 },
  metadata: pillagerMetadata, equipment: [{ name: 'crossbow' }] });
run(1300);
assert.match(context.cortiBowTexture('crossbow').userData.url,
  /crossbow_standby\.png$/, 'crossbow standby uses 1.20.6 texture');
assert.match(pillager.userData.cortiMobMotion.ranged.material.map.userData.url,
  /crossbow_pulling_0\.png$/, 'pillager begins charging');
run(2150);
assert.match(pillager.userData.cortiMobMotion.ranged.material.map.userData.url,
  /crossbow_pulling_2\.png$/, 'pillager charging metadata drives draw texture');

const evoker = new THREE.Group();
evoker.name = 'mesh';
const evokerArm = bone(evoker, 'rightArm');
bone(evoker, 'leftArm');
const evokerScene = new THREE.Group();
evokerScene.add(evoker);
scenes['105'] = evokerScene;
const evokerMetadata = [];
evokerMetadata[17] = 2;
entities.set('105', { id: 105, name: 'evoker', pos: { x: 8, y: 0, z: 0 },
  metadata: evokerMetadata });
run(2200);
assert.ok(evokerArm.rotation.x > 1, 'evoker raises arms while casting');

const shulker = new THREE.Group();
shulker.name = 'mesh';
const lid = new THREE.Mesh(new THREE.BoxGeometry(1, .25, 1).translate(0, .85, 0));
lid.name = 'lid';
shulker.add(lid);
const shulkerScene = new THREE.Group();
shulkerScene.add(shulker);
scenes['106'] = shulkerScene;
const shulkerMetadata = [];
shulkerMetadata[17] = 100;
entities.set('106', { id: 106, name: 'shulker', pos: { x: 10, y: 0, z: 0 },
  metadata: shulkerMetadata });
run(2300);
const lidPart = shulker.userData.cortiMobMotion.parts.get('lid')[0];
assert.ok(lidPart.object.position.y > lidPart.basePosition.y + .4,
  'shulker lid opens by the packet peek value');

});
