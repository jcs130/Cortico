import { expect, it } from 'vitest';
import * as THREE from 'three';
// @ts-expect-error renderer module is bundled for browsers
import { VRMBodyLayer } from '../web/vrm-body.js';

function actor(props = false) {
  const root = new THREE.Group(), scene = new THREE.Group(); root.add(scene);
  const bones = new Map<string,THREE.Object3D>();
  const add = (name:string, parent:THREE.Object3D, xyz:number[]) => {
    const bone = new THREE.Object3D(); bone.name=name; bone.position.set(xyz[0],xyz[1],xyz[2]); parent.add(bone); bones.set(name,bone); return bone;
  };
  const hips=add('hips',scene,[0,1,0]), spine=add('spine',hips,[0,.2,0]), chest=add('chest',spine,[0,.2,0]);
  add('head',chest,[0,.3,0]);
  for (const side of ['left','right']) {
    const s=side==='left'?1:-1, thigh=add(side+'UpperLeg',hips,[s*.1,0,0]);
    const shin=add(side+'LowerLeg',thigh,[0,-.45,0]); add(side+'Foot',shin,[0,-.45,0]);
    const upper=add(side+'UpperArm',chest,[s*.15,.1,0]), lower=add(side+'LowerArm',upper,[s*.3,0,0]);
    const hand=add(side+'Hand',lower,[s*.25,0,0]);
    for(const finger of ['Index','Middle','Ring','Little']) {
      const a=add(side+finger+'Proximal',hand,[s*.06,0,0]), b=add(side+finger+'Intermediate',a,[s*.03,0,0]);
      add(side+finger+'Distal',b,[s*.02,0,0]);
    }
  }
  const vrm={scene,humanoid:{getNormalizedBoneNode:(n:string)=>bones.get(n)}};
  const layer=new VRMBodyLayer(vrm,root,{props});
  const step = (mode:string, n=120, extra:Record<string,unknown>={}) => {
    for(let i=0;i<n;i++) { layer.restore(); layer.apply({mode,modeT:i/60,heading:1,velocity:[78,0],scale:1,...extra},1/60,{authoredLocomotion:true}); scene.updateMatrixWorld(true); layer.updateProps(); }
  };
  return {layer,bones,root,scene,step};
}
it('turns in three dimensions without mirroring or losing width through reversal',()=>{
  const a=actor(); a.step('walk'); expect(a.root.rotation.y).toBeCloseTo(Math.PI/2,3);
  const front = new THREE.Vector3(0,0,1).applyQuaternion(a.root.quaternion);
  expect(front.x).toBeGreaterThan(.99); expect(a.root.scale.toArray()).toEqual([1,1,1]);
  a.step('run',120,{heading:-1,velocity:[-250,0]});
  expect(new THREE.Vector3(0,0,1).applyQuaternion(a.root.quaternion).x).toBeLessThan(-.99);
  a.step('idle'); expect(Math.sin(a.root.rotation.y)).toBeCloseTo(0,3); a.layer.dispose();
});
it('sits with folded hips and knees while feet retain floor height, then stands without drift',()=>{
  const a=actor(), foot=a.bones.get('leftFoot')!, hips=a.bones.get('hips')!;
  const floor=foot.getWorldPosition(new THREE.Vector3()).y;
  a.step('sit',600); expect(hips.position.y).toBeCloseTo(.55,3);
  expect(foot.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(floor,3);
  expect(Math.abs(a.bones.get('leftUpperLeg')!.rotation.x)).toBeGreaterThan(1.5);
  a.step('idle',300); expect(hips.position.y).toBeCloseTo(1,4); expect(foot.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(floor,4);
  a.layer.dispose();
});
it('keeps a held prop after its gesture ends, follows the hand, and clears it on put-away',()=>{
  const a=actor(true); a.step('idle',90,{gesture:{kind:'hold-cup',k:.5}});
  expect(a.layer.meshes.cup.visible).toBe(true);
  a.step('walk',120); expect(a.layer.state.item).toBe('cup'); expect(a.layer.meshes.cup.visible).toBe(true);
  a.step('sit',120,{gesture:{kind:'read-book',k:.5}}); expect(a.layer.meshes.book.visible).toBe(true); expect(a.layer.meshes.chair.visible).toBe(true);
  a.step('idle',120,{gesture:{kind:'put-away',k:.5}}); expect(a.layer.meshes.cup.visible).toBe(false); expect(a.layer.meshes.book.visible).toBe(false);
  a.layer.dispose();
});
it('does not overwrite a manual animation in relaxed stance or accumulate finger curl',()=>{
  const a=actor(), hand=a.bones.get('rightHand')!, finger=a.bones.get('rightIndexProximal')!;
  hand.rotation.y=.3;
  a.step('idle',300); expect(hand.rotation.y).toBeCloseTo(.3);
  a.step('idle',600,{gesture:{kind:'hold-cup',k:.5}}); expect(finger.rotation.z).toBeCloseTo(.55,3);
  a.step('idle',300,{gesture:{kind:'put-away',k:.5}}); expect(finger.rotation.z).toBeCloseTo(0,3);
  a.layer.dispose();
});
