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
assert.ok(ranged.arrow.visible, 'nocked arrow appears during draw');
assert.equal(ranged.material.side, THREE.FrontSide, 'ranged sprite uses outward faces');
assert.ok(Math.abs(ranged.reverse.rotation.y - Math.PI) < 1e-8,
  'back face has its own unmirrored texture');
assert.equal(skeleton.frustumCulled, true, 'group itself is not a mesh');

const scaledSkeleton = new THREE.Group();
scaledSkeleton.name = 'mesh';
scaledSkeleton.scale.setScalar(1 / 16);
bone(scaledSkeleton, 'rightArm');
const scaledScene = new THREE.Group();
scaledScene.add(scaledSkeleton);
// The live Prismarine rig has a 1/16 ancestor, even though the weapon plane is in block units.
scenes['107'] = scaledScene;
entities.set('107', { id: 107, name: 'skeleton', pos: { x: 2, y: 0, z: 0 },
  equipment: [null] });
run(925);
const scaledBow = scaledSkeleton.userData.cortiMobMotion.ranged;
assert.ok(Math.abs(scaledBow.group.getWorldScale(new THREE.Vector3()).x - 1) < 1e-8,
  'mob model scale does not shrink the bow sprite');
assert.ok(scaledBow.group.getWorldPosition(new THREE.Vector3()).distanceTo(
  scaledBow.group.parent.getWorldPosition(new THREE.Vector3())) > .5,
  'bow hangs at hand distance in block units');

const scaledVindicator = new THREE.Group();
scaledVindicator.name = 'mesh';
scaledVindicator.scale.setScalar(1 / 16);
bone(scaledVindicator, 'rightArm');
const vindicatorScene = new THREE.Group();
vindicatorScene.add(scaledVindicator);
scenes['108'] = vindicatorScene;
entities.set('108', { id: 108, name: 'vindicator', pos: { x: 3, y: 0, z: 0 },
  equipment: [{ name: 'iron_axe' }] });
run(950);
const scaledAxe = scaledVindicator.userData.cortiMobMotion.held;
assert.ok(scaledAxe.group.visible, 'vindicator weapon appears');
assert.ok(Math.abs(scaledAxe.group.getWorldScale(new THREE.Vector3()).x - 1) < 1e-8,
  'mob model scale does not shrink melee equipment');
const unreliableAxe = new THREE.Group();
unreliableAxe.name = 'custom_item_left';
scaledVindicator.add(unreliableAxe);
entities.get('108').equipment = [null];
run(975);
assert.equal(unreliableAxe.visible, false, 'vindicator uses the hand aligned axe instead of the native item');
assert.equal(scaledVindicator.userData.cortiMobMotion.held.weapon, 'iron_axe',
  'vanilla vindicator still has an axe when equipment packets omit it');

metadata[0] = 1;
run(980);
assert.ok(skeletonScene.getObjectByName('corti-entity-fire')?.visible,
  'burning metadata adds flames to the world model');
metadata[0] = 0;
run(985);
assert.equal(skeletonScene.getObjectByName('corti-entity-fire')?.visible, false,
  'flames disappear when the fire flag clears');

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
assert.equal(ranged.arrow.visible, false, 'nocked arrow leaves bow');

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
assert.equal(pillager.userData.cortiMobMotion.ranged.material.side, THREE.FrontSide,
  'crossbow is not mirrored from behind');
assert.ok(Math.abs(pillager.userData.cortiMobMotion.ranged.reverse.rotation.y - Math.PI) < 1e-8);
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

const witch = new THREE.Group();
witch.name = 'mesh';
const witchArms = bone(witch, 'arms');
const witchScene = new THREE.Group();
witchScene.add(witch);
scenes['109'] = witchScene;
entities.set('109', { id: 109, name: 'witch', pos: { x: 12, y: 0, z: 0 },
  equipment: [null] });
const potionScene = new THREE.Group();
const nativePotion = new THREE.Group();
nativePotion.name = 'mesh';
potionScene.add(nativePotion);
scenes['110'] = potionScene;
const potionMetadata = [];
potionMetadata[8] = { name: 'splash_potion' };
entities.set('110', { id: 110, name: 'potion', pos: { x: 12.2, y: 1.3, z: 0 },
  metadata: potionMetadata, velocity: { x: .1, y: .1, z: 0 } });
run(3000);
const thrownPotion = potionScene.getObjectByName('corti-thrown-potion');
assert.ok(thrownPotion?.visible, 'witch splash potion has an explicit projectile model');
assert.equal(nativePotion.visible, false, 'native projectile is hidden under the explicit model');
assert.match(thrownPotion.children[0].children[0].material.map.userData.url, /splash_potion\.png$/);
assert.match(thrownPotion.children[0].children[1].material.map.userData.url, /potion_overlay\.png$/);
run(3150);
assert.notEqual(thrownPotion.rotation.y, 0, 'potion bottle spins during flight');
assert.ok(witchArms.rotation.x > .1, 'nearby witch throws when the potion appears');
const witchMetadata = [];
witchMetadata[17] = true;
entities.get('109').metadata = witchMetadata;
run(3175);
assert.equal(witchArms.rotation.x, .55, 'witch drinking pose follows its 1.20.6 using_item metadata');
witchMetadata[17] = false;

const drowned = new THREE.Group();
drowned.name = 'mesh';
drowned.scale.setScalar(1 / 16);
bone(drowned, 'rightArm');
const nativeTrident = new THREE.Group();
nativeTrident.name = 'custom_item_left';
drowned.add(nativeTrident);
const drownedScene = new THREE.Group();
drownedScene.add(drowned);
scenes['111'] = drownedScene;
entities.set('111', { id: 111, name: 'drowned', pos: { x: 14, y: 0, z: 0 },
  equipment: [{ name: 'trident' }] });
run(3200);
const heldTrident = drowned.userData.cortiMobMotion.held;
assert.ok(heldTrident.group.visible, 'equipped drowned holds a trident');
assert.equal(nativeTrident.visible, false, 'unreliable native item does not overlap the trident');
assert.equal(heldTrident.item.name, 'corti-held-trident');
assert.ok(heldTrident.item.children.length > 4, 'held trident has shaft and prongs');

const adultZombie = new THREE.Group();
adultZombie.name = 'mesh';
adultZombie.scale.setScalar(1 / 16);
const adultArm = bone(adultZombie, 'rightArm');
const adultSword = new THREE.Group();
adultSword.name = 'custom_item_left';
adultZombie.add(adultSword);
const adultScene = new THREE.Group();
adultScene.add(adultZombie);
scenes['112'] = adultScene;
entities.set('112', { id: 112, name: 'zombie', height: 1.95, pos: { x: 16, y: 0, z: 0 },
  equipment: [{ name: 'iron_sword' }] });
const babyZombie = new THREE.Group();
babyZombie.name = 'mesh';
babyZombie.scale.setScalar(1 / 32);
const babyArm = bone(babyZombie, 'rightArm');
const babySword = new THREE.Group();
babySword.name = 'custom_item_left';
babyZombie.add(babySword);
const babyScene = new THREE.Group();
babyScene.add(babyZombie);
scenes['113'] = babyScene;
const babyMetadata = [];
babyMetadata[16] = true;
entities.set('113', { id: 113, name: 'zombie', height: .975, pos: { x: 18, y: 0, z: 0 },
  metadata: babyMetadata, equipment: [{ name: 'iron_sword' }] });
run(3300);
assert.equal(adultSword.parent, adultArm);
assert.equal(babySword.parent, babyArm);
const adultGrip = adultSword.getWorldPosition(new THREE.Vector3())
  .distanceTo(adultArm.getWorldPosition(new THREE.Vector3()));
const babyGrip = babySword.getWorldPosition(new THREE.Vector3())
  .distanceTo(babyArm.getWorldPosition(new THREE.Vector3()));
assert.ok(adultGrip > .5 && babyGrip < .4, 'baby weapon reaches its smaller wrist');
assert.ok(babyGrip < adultGrip * .6, 'baby weapon offset scales with the body');

const blaze = new THREE.Group();
blaze.name = 'mesh';
const blazeScene = new THREE.Group();
blazeScene.add(blaze);
scenes['114'] = blazeScene;
entities.set('114', { id: 114, name: 'blaze', pos: { x: 20, y: 0, z: 0 } });
const fireballScene = new THREE.Group();
const nativeFireball = new THREE.Group();
nativeFireball.name = 'mesh';
fireballScene.add(nativeFireball);
scenes['115'] = fireballScene;
entities.set('115', { id: 115, name: 'small_fireball', pos: { x: 20.1, y: 1.3, z: 0 },
  velocity: { x: 0, y: 0, z: 1 } });
run(3400);
assert.ok(fireballScene.getObjectByName('corti-fireball-flight')?.visible,
  'blaze shot has a visible fireball');
assert.equal(nativeFireball.visible, false, 'explicit fireball replaces the unsupported native model');
run(3500);
assert.ok(blaze.position.y > .01, 'blaze reacts to launching a fireball');

});
