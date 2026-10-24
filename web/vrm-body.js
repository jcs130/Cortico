import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, rate, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-rate * dt));
const quat = angles => new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles));
const lerpAngle = (a, b, dt) => a + Math.atan2(Math.sin(b-a), Math.cos(b-a)) * (1-Math.exp(-8*dt));
const BONE_NAMES = ['hips','spine','chest','head','leftUpperLeg','leftLowerLeg','leftFoot','rightUpperLeg','rightLowerLeg','rightFoot',
  'leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand'];
const FINGERS = ['Index','Middle','Ring','Little'];

/** Spatial posture and props for standard VRM humanoids. The host owns stage travel and arrival receipts. */
export class VRMBodyLayer {
  constructor(vrm, root, { props = true } = {}) {
    this.vrm = vrm; this.root = root;
    this.bones = new Map(BONE_NAMES.map(n => [n, vrm.humanoid.getNormalizedBoneNode(n)]).filter(([, b]) => b));
    for (const side of ['left','right']) for (const finger of [...FINGERS,'Thumb'])
      for (const joint of finger === 'Thumb' ? ['Metacarpal','Proximal','Distal'] : ['Proximal','Intermediate','Distal']) {
        const name = side + finger + joint, bone = vrm.humanoid.getNormalizedBoneNode(name);
        if (bone) this.bones.set(name, bone);
      }
    this.rest = new Map([...this.bones].map(([n,b]) => [n, { q:b.quaternion.clone(), p:b.position.clone() }]));
    this.saved = new Map(); this.time = 0; this.yaw = 0; this.sit = 0; this.air = 0; this.crouch = 0;
    this.item = null; this.itemWeight = 0; this.gait = 0; this.lastGesture = ''; this.turn = null;
    const a = this.bones.get('leftUpperLeg'), b = this.bones.get('leftLowerLeg');
    vrm.scene.updateMatrixWorld(true);
    this.leg = a && b ? a.getWorldPosition(new THREE.Vector3()).distanceTo(b.getWorldPosition(new THREE.Vector3())) : .25;
    this.propRoot = new THREE.Group(); vrm.scene.add(this.propRoot);
    this.meshes = props ? this.makeProps() : {};
    this.state = { mode:'idle', yaw:0, item:null, sitting:0, authoredLocomotion:false };
  }
  remember(bone) {
    if (!this.saved.has(bone)) this.saved.set(bone, { q:bone.quaternion.clone(), p:bone.position.clone() });
  }
  restore() {
    for (const [b, s] of this.saved) { b.quaternion.copy(s.q); b.position.copy(s.p); }
    this.saved.clear();
  }
  pose(name, angles, weight) {
    const b = this.bones.get(name); if (!b || weight < .0001) return;
    this.remember(b); const target = this.rest.get(name).q.clone().multiply(quat(angles));
    b.quaternion.slerp(target, clamp(weight, 0, 1));
  }
  offset(name, xyz, weight = 1) {
    const b = this.bones.get(name); if (!b || weight < .0001) return;
    this.remember(b); b.position.addScaledVector(new THREE.Vector3(...xyz), weight);
  }
  setItem(item) { this.item = item; }
  /** Restore before the animation mixer runs, then apply after it samples. Overlays never accumulate. */
  apply(frame, dt, { authoredLocomotion = false, gestureActive = false } = {}) {
    this.time += dt;
    const mode = frame.mode, moving = mode === 'walk' || mode === 'run';
    const gesture = frame.gesture?.kind ?? '';
    if (gesture !== this.lastGesture) {
      if (gesture === 'hold-cup') this.setItem('cup');
      if (gesture === 'read-book') this.setItem('book');
      if (gesture === 'put-away') this.setItem(null);
      if (['turn-left','turn-right','turn-front','show-back'].includes(gesture))
        this.turn = { yaw: { 'turn-left':-Math.PI/2, 'turn-right':Math.PI/2, 'turn-front':0, 'show-back':Math.PI }[gesture], until:this.time+3 };
      this.lastGesture = gesture;
    }
    if (this.turn && this.time > this.turn.until) this.turn = null;
    let yaw = moving ? (frame.heading ?? Math.sign(frame.velocity?.[0]) ?? 1) * Math.PI/2 : this.turn?.yaw ?? 0;
    if (gesture === 'spin') yaw = (frame.gesture.k ?? 0) * Math.PI * 2;
    this.yaw = gesture === 'spin' ? yaw : lerpAngle(this.yaw, yaw, dt);
    this.root.rotation.y = this.yaw;
    if (mode === 'look') this.pose('head', [(frame.look?.[1] ?? 0)*.035, (frame.look?.[0] ?? 0)*.04, 0], 1);
    this.sit = smooth(this.sit, ['sit','sleep'].includes(mode) ? 1 : 0, 7, dt);
    this.air = smooth(this.air, ['air','drag'].includes(mode) ? 1 : 0, 12, dt);
    this.crouch = smooth(this.crouch, mode === 'crouch' ? .55 : mode === 'land' ? .32 * Math.max(0,1-frame.modeT/.35) : 0, 20, dt);
    const squat = Math.max(this.crouch, this.air * .28), seated = this.sit;
    for (const side of ['left','right']) {
      this.pose(side+'UpperLeg', [-Math.PI/2,0,0], seated);
      this.pose(side+'LowerLeg', [Math.PI/2,0,0], seated);
      this.pose(side+'Foot', [0,0,0], seated);
      this.pose(side+'UpperLeg', [-.65,0,0], squat);
      this.pose(side+'LowerLeg', [1.3,0,0], squat);
      this.pose(side+'Foot', [-.65,0,0], squat);
      const sign = side === 'left' ? -1 : 1;
      this.pose(side+'UpperArm', [-.08,0,sign*1.18], Math.max(seated,this.air*.7));
      this.pose(side+'LowerArm', [0,sign*.8,0], seated);
    }
    this.offset('hips', [0,-this.leg*seated-this.leg*.18*squat,0]);
    if (moving) {
      const hips = this.bones.get('hips');
      if (hips) { this.remember(hips); hips.position.x = this.rest.get('hips').p.x; hips.position.z = this.rest.get('hips').p.z; }
      if (!authoredLocomotion) {
        const speed = Math.abs(frame.velocity?.[0] ?? 0) / Math.max(.1, frame.scale ?? 1);
        this.gait += dt * speed / 100 * Math.PI*2;
        for (const [i, side] of ['left','right'].entries()) {
          const phase = this.gait+i*Math.PI, stride = mode === 'run' ? .6 : .35;
          this.pose(side+'UpperLeg', [Math.sin(phase)*stride,0,0], 1);
          this.pose(side+'LowerLeg', [Math.max(0,-Math.sin(phase))*.8,0,0], 1);
        }
      }
    }
    this.itemWeight = smooth(this.itemWeight, this.item ? 1 : 0, 9, dt);
    if (this.itemWeight > .001) {
      const book = this.item === 'book', w = this.itemWeight;
      for (const side of book ? ['left','right'] : ['right']) {
        const sign = side === 'left' ? -1 : 1;
        this.pose(side+'UpperArm', [-.15,0,sign*(book ? 1.47 : 1.15)], w);
        this.pose(side+'LowerArm', [0,sign*1.28,0], w);
        this.pose(side+'Hand', [0,0,0], w);
        for (const finger of FINGERS) for (const [j,joint] of ['Proximal','Intermediate','Distal'].entries())
          this.pose(side+finger+joint, [0,0,sign*(book ? [.25,.45,.3] : [.55,.72,.48])[j]], w);
        this.pose(side+'ThumbMetacarpal', [0,sign*.35,-sign*.35], w);
        this.pose(side+'ThumbProximal', [0,0,sign*.35], w);
      }
      if (book) this.pose('head', [.22,0,0], w*.65);
    }
    this.state = { mode, yaw:this.yaw, item:this.item, sitting:this.sit, authoredLocomotion,
      air:this.air, crouch:this.crouch, gestureActive };
    return this.state;
  }
  makeProps() {
    const l = this.leg, material = color => new THREE.MeshStandardMaterial({ color, roughness:.7 });
    const mesh = (g, m, parent) => { const o = new THREE.Mesh(g,m); parent.add(o); return o; };
    const cup = new THREE.Group(), ceramic=material(0x96c8bd), rim=material(0xece4d5);
    mesh(new THREE.CylinderGeometry(l*.15,l*.13,l*.33,24), ceramic, cup);
    const top=mesh(new THREE.TorusGeometry(l*.15,l*.016,8,24),rim,cup); top.rotation.x=Math.PI/2; top.position.y=l*.17;
    const handle=mesh(new THREE.TorusGeometry(l*.105,l*.023,8,20),ceramic,cup); handle.position.x=l*.2;
    const book = new THREE.Group(), cover=material(0x4d8079), paper=material(0xfff3dd);
    for(const side of [-1,1]) {
      const page=new THREE.Group(); book.add(page); page.position.x=side*l*.19; page.rotation.y=side*.22;
      mesh(new THREE.BoxGeometry(l*.38,l*.55,l*.032),paper,page);
      const back=mesh(new THREE.BoxGeometry(l*.4,l*.57,l*.024),cover,page); back.position.z=-l*.035;
      for(let i=0;i<5;i++) { const line=mesh(new THREE.BoxGeometry(l*.25,l*.008,l*.004),cover,page); line.position.set(0,l*(.17-i*.07),l*.02); }
    }
    const chair = new THREE.Group(), wood=material(0xc59c6b);
    const seat = mesh(new THREE.BoxGeometry(l*.86,l*.08,l*.76),wood,chair);
    const legs=[];
    for (const x of [-.32,.32]) for (const z of [-.27,.27]) {
      const leg=mesh(new THREE.BoxGeometry(l*.075,1,l*.075),wood,chair); leg.position.set(x*l,0,z*l); legs.push(leg);
    }
    this.propRoot.add(cup,book,chair);
    for(const group of [cup,book,chair]) group.visible=false;
    return {cup,book,chair,seat,legs};
  }
  /** Called after vrm.update(): props follow the current normalized hand joints and floor. */
  updateProps() {
    const {cup,book,chair,seat,legs}=this.meshes; if (!cup) return;
    this.vrm.scene.updateMatrixWorld(true);
    const local = bone => this.vrm.scene.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
    const right=this.bones.get('rightHand'), left=this.bones.get('leftHand');
    cup.visible=this.item==='cup' && this.itemWeight>.1 && !!right;
    book.visible=this.item==='book' && this.itemWeight>.1 && !!right && !!left;
    if (cup.visible) { cup.position.copy(local(right)); cup.position.z+=this.leg*.12; cup.position.y-=this.leg*.04; cup.scale.setScalar(this.itemWeight); }
    if (book.visible) {
      const r = local(right), l = local(left);
      book.position.copy(r).add(l).multiplyScalar(.5); book.position.z+=this.leg*.12;
      const width = clamp(Math.abs(r.x-l.x)/(this.leg*.8), .8, 1.5);
      book.rotation.x=-.5; book.scale.set(this.itemWeight*width, this.itemWeight, this.itemWeight);
    }
    chair.visible=this.sit>.08;
    if (chair.visible) {
      const hips=this.bones.get('hips'), foot=this.bones.get('leftFoot');
      const h=local(hips), f=foot?local(foot):new THREE.Vector3();
      const top=h.y-this.leg*.12, bottom=Math.min(f.y-this.leg*.1, .03), height=Math.max(this.leg*.25, top-bottom);
      chair.position.set(h.x,0,h.z-this.leg*.06); seat.position.y=top;
      for(const leg of legs) { leg.scale.y=height; leg.position.y=bottom+height*.5; }
      chair.scale.set(this.sit,1,this.sit);
    }
  }
  dispose() {
    this.restore(); this.propRoot.traverse(o=>{o.geometry?.dispose(); const m=o.material; if(m) for(const a of Array.isArray(m)?m:[m]) a.dispose();});
    this.propRoot.removeFromParent();
  }
}
