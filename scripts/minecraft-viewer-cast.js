/** The viewer shows cast facts from the Minecraft World over the game picture. */
let cortiCastSequence = -1;
let cortiCastPhase = '';
let cortiCastTimer = null;
const cortiSkillEffects = [];

function cortiStartSkillEffect(event) {
  if (event.phase === 'failed') return;
  const three = globalThis.THREE;
  const world = globalThis.world;
  const pos = pendingAvatarState?.entity?.pos || latestPosition?.pos;
  if (!three || !world?.scene || !world.sceneOrigin || !pos) return;
  const spell = String(event.spellId || '');
  const color = /frost|night|flight|feather/.test(spell) ? 0x81ddff
    : /flame|fireworks|blood/.test(spell) ? 0xff873b
      : /heal|food|golem/.test(spell) ? 0x9bf2a1 : 0xc1a0ff;
  const group = new three.Group();
  group.name = 'corti-skill-vfx';
  const material = new three.MeshBasicMaterial({ color, transparent: true, opacity: .66,
    blending: three.AdditiveBlending, depthWrite: false, side: three.DoubleSide, toneMapped: false });
  const ring = new three.Mesh(new three.TorusGeometry(1, .025, 6, 64), material);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  const sparks = [];
  const count = event.phase === 'sent' ? 9 : 24;
  for (let i = 0; i < count; i++) {
    const spark = new three.Mesh(new three.SphereGeometry(.025 + (i % 4) * .006, 5, 5), material);
    spark.userData.angle = i * Math.PI * 2 / count;
    spark.userData.radius = .4 + (i % 5) * .17;
    group.add(spark);
    sparks.push(spark);
  }
  world.scene.add(group);
  cortiSkillEffects.push({ group, ring, sparks, material, spell,
    pos: { x: pos.x, y: pos.y, z: pos.z }, at: performance.now(),
    duration: event.phase === 'sent' ? 650 : 1600, phase: event.phase });
  while (cortiSkillEffects.length > 8) cortiDisposeSkillEffect(cortiSkillEffects.shift());
}

function cortiDisposeSkillEffect(effect) {
  if (!effect) return;
  effect.group.parent?.remove(effect.group);
  effect.ring.geometry.dispose();
  for (const spark of effect.sparks) spark.geometry.dispose();
  effect.material.dispose();
}

function cortiAnimateSkillEffects(now) {
  const origin = globalThis.world?.sceneOrigin;
  for (let i = cortiSkillEffects.length - 1; i >= 0; i--) {
    const effect = cortiSkillEffects[i];
    const progress = (now - effect.at) / effect.duration;
    if (progress >= 1 || !origin) {
      cortiDisposeSkillEffect(effect);
      cortiSkillEffects.splice(i, 1);
      continue;
    }
    effect.group.position.set(origin.toSceneX(effect.pos.x),
      origin.toSceneY(effect.pos.y + .16), origin.toSceneZ(effect.pos.z));
    const isFrost = effect.spell === 'frostnova';
    const isFlame = effect.spell === 'flamewave';
    const isHome = effect.spell === 'home' || effect.spell === 'blink';
    const radius = (isFrost ? 6 : isFlame ? 3.4 : isHome ? 1.6 : 1.2) * (progress * .82 + .12);
    effect.ring.scale.setScalar(radius);
    effect.ring.rotation.z += .018;
    effect.material.opacity = .64 * (1 - progress) * (effect.phase === 'sent' ? .45 : 1);
    for (const spark of effect.sparks) {
      const angle = spark.userData.angle + now * (isHome ? .003 : .001);
      const distance = spark.userData.radius * (isFrost || isFlame ? 1 + progress * 3 : 1);
      spark.position.set(Math.cos(angle) * distance,
        (isHome ? progress * 2 : .25 + progress * 1.2) + Math.sin(angle * 3) * .15,
        Math.sin(angle) * distance);
    }
  }
  requestAnimationFrame(cortiAnimateSkillEffects);
}
requestAnimationFrame(cortiAnimateSkillEffects);

function cortiInstallCastCue(socket) {
  const root = document.getElementById('corti-cast');
  if (!root) return;
  socket.on('connect', () => {
    cortiCastSequence = -1;
    cortiCastPhase = '';
    root.hidden = true;
    if (cortiCastTimer !== null) clearTimeout(cortiCastTimer);
    cortiCastTimer = null;
  });
  socket.on('castCue', (event) => {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0 ||
        !['sent', 'succeeded', 'failed'].includes(event.phase) ||
        typeof event.spellName !== 'string' || event.spellName.length > 80) return;
    if (event.seq === cortiCastSequence && cortiCastPhase !== 'sent' && event.phase === 'sent') return;
    cortiCastSequence = event.seq;
    cortiCastPhase = event.phase;
    cortiStartSkillEffect(event);
    root.hidden = false;
    root.dataset.phase = event.phase;
    root.querySelector('[data-cast-phase]').textContent = event.phase === 'sent'
      ? '✦ 使用技能 · 咏唱' : event.phase === 'succeeded'
        ? '✦ 使用技能 · 生效' : '✦ 使用技能 · 受阻';
    root.querySelector('[data-cast-name]').textContent = event.spellName;
    root.querySelector('[data-cast-detail]').textContent = event.phase === 'sent'
      ? '法术已发出，等待回应' : typeof event.detail === 'string' ? event.detail.slice(0, 80) : '';
    const line = root.querySelector('.corti-cast-line');
    line.style.animation = 'none';
    void line.offsetWidth;
    line.style.animation = '';
    if (cortiCastTimer !== null) clearTimeout(cortiCastTimer);
    const sequence = event.seq;
    cortiCastTimer = setTimeout(() => {
      if (cortiCastSequence === sequence) root.hidden = true;
      cortiCastTimer = null;
    }, event.phase === 'sent' ? 5_000 : 4_000);
  });
}

cortiInstallCastCue(socket);
