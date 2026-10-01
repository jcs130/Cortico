/** Read-only 1.20.6 inventory, container, minimap and skill overlays. */
let cortiPanelAvatar = null;
let cortiPanelWindow = null;
let cortiInventoryOpen = false;
let cortiPanelMap = null;
let cortiPanelSkills = null;
let cortiMapDrawAt = 0;
let cortiMenuSignature = '';

const cortiMenuTextures = '/textures/gui/container/';
const cortiTerrainColors = Object.freeze({
  '?': '#26343b', ' ': '#27323b', W: '#4b91c1', L: '#ed743c', F: '#4f9a63',
  T: '#826545', G: '#91b75d', P: '#ad9a6d', S: '#d7c68b', N: '#edf1e5',
  C: '#b7bd69', R: '#929ca0', B: '#8f725b', H: '#a57d66', X: '#8b8e7b',
});

function cortiInstallPanels(socket) {
  const button = document.getElementById('corti-inventory-toggle');
  const menu = document.getElementById('corti-menu');
  button?.addEventListener('click', () => {
    cortiInventoryOpen = !cortiInventoryOpen;
    cortiRenderMenu();
  });
  menu?.querySelector('[data-menu-close]')?.addEventListener('click', () => {
    cortiInventoryOpen = false;
    menu.hidden = true;
  });
  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    if (event.code === 'KeyE') {
      cortiInventoryOpen = !cortiInventoryOpen;
      cortiRenderMenu();
      event.preventDefault();
    } else if (event.code === 'Escape' && menu && !menu.hidden) {
      cortiInventoryOpen = false;
      menu.hidden = true;
      event.preventDefault();
    }
  });
  socket.on('avatarState', (state) => {
    cortiPanelAvatar = state;
    cortiRenderMana();
    if (cortiInventoryOpen && !cortiPanelWindow) cortiRenderMenu();
    if (performance.now() - cortiMapDrawAt > 120) {
      cortiMapDrawAt = performance.now();
      cortiDrawMinimap();
    }
  });
  socket.on('containerState', (state) => {
    const previousId = cortiPanelWindow?.id;
    cortiPanelWindow = state && typeof state === 'object' ? state : null;
    if (cortiPanelWindow || previousId !== undefined || cortiInventoryOpen) cortiRenderMenu();
  });
  socket.on('minimap', (state) => {
    if (!state || typeof state.cells !== 'string' || state.radius !== 12 || state.cells.length !== 625) return;
    cortiPanelMap = state;
    cortiDrawMinimap();
  });
  socket.on('skillsState', (state) => {
    cortiPanelSkills = state;
    cortiRenderSkills();
  });
  cortiRenderSkills();
}

function cortiRenderMenu() {
  const root = document.getElementById('corti-menu');
  if (!root) return;
  const container = cortiPanelWindow;
  if (!container && !cortiInventoryOpen) { root.hidden = true; return; }
  const signature = JSON.stringify(container || cortiPanelAvatar?.inventory || []);
  const wasHidden = root.hidden;
  root.hidden = false;
  if (!wasHidden && signature === cortiMenuSignature) return;
  cortiMenuSignature = signature;
  root.querySelector('[data-menu-title]').textContent = container?.title || '背包';
  root.querySelector('[data-menu-source]').textContent = container ? '游戏窗口 · 只读' : '玩家物品 · 只读';
  const target = root.querySelector('[data-menu-body]');
  target.replaceChildren();
  if (!container) { cortiRenderInventory(target, cortiPanelAvatar?.inventory); return; }
  const type = String(container.type || '').replace(/^minecraft:/, '');
  if (['furnace', 'blast_furnace', 'smoker'].includes(type)) {
    cortiRenderFurnace(target, container, type);
  } else if (type === 'crafting' || type === 'crafting_table') {
    cortiRenderCrafting(target, container);
  } else {
    cortiRenderGenericContainer(target, container);
  }
}

function cortiVanillaBackground(parent, name) {
  const body = document.createElement('div');
  body.className = 'corti-menu-body corti-menu-vanilla';
  body.style.backgroundImage = `url("${cortiMenuTextures}${name}.png")`;
  parent.append(body);
  return body;
}

function cortiSlot(parent, x, y, item, label = '') {
  const slot = document.createElement('div');
  slot.className = 'corti-menu-slot';
  slot.style.left = `${x * 2}px`;
  slot.style.top = `${y * 2}px`;
  const durability = cortiDurability(item);
  slot.title = item ? `${item.displayName || item.name} × ${item.count || 1}${item.enchanted === true ? ' · 附魔' : ''}${durability ? ` · 耐久 ${durability.left}/${durability.max}` : ''}` : label;
  if (item) {
    const name = String(item.name || '').replace(/^minecraft:/, '');
    if (/^[a-z0-9_]+$/.test(name)) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = `/icons/${name}.png`;
      image.onerror = () => {
        if (!image.isConnected) return;
        image.remove();
        cortiSlotFallback(slot, item);
      };
      slot.append(image);
    } else cortiSlotFallback(slot, item);
    cortiAppendHeadFace(slot, item, 2);
    cortiAppendEnchantmentGlint(slot, item, 2);
    cortiAppendDurability(slot, item);
    if (Number(item.count) > 1) {
      const count = document.createElement('small');
      count.textContent = String(item.count);
      slot.append(count);
    }
  }
  parent.append(slot);
  return slot;
}

function cortiSlotFallback(slot, item) {
  const fallback = document.createElement('span');
  fallback.className = 'corti-item-fallback';
  fallback.textContent = String(item.displayName || item.name).slice(0, 2);
  slot.prepend(fallback);
}

function cortiPlayerRows(parent, slots, start, hotbarStart, y = 84) {
  for (let i = 0; i < 27; i++) {
    cortiSlot(parent, 8 + (i % 9) * 18, y + Math.floor(i / 9) * 18,
      slots?.[start + i], `背包 ${i + 1}`);
  }
  for (let i = 0; i < 9; i++) {
    cortiSlot(parent, 8 + i * 18, y + 58, slots?.[hotbarStart + i], `快捷栏 ${i + 1}`);
  }
}

function cortiRenderInventory(parent, slots) {
  const body = cortiVanillaBackground(parent, 'inventory');
  for (let i = 0; i < 4; i++) cortiSlot(body, 8, 8 + i * 18, slots?.[5 + i], '护甲');
  for (let i = 0; i < 4; i++) cortiSlot(body, 98 + (i % 2) * 18, 18 + Math.floor(i / 2) * 18, slots?.[1 + i], '合成');
  cortiSlot(body, 154, 28, slots?.[0], '合成结果');
  cortiSlot(body, 77, 62, slots?.[45], '副手');
  cortiPlayerRows(body, slots, 9, 36);
}

function cortiRenderFurnace(parent, container, type) {
  const slots = container.slots;
  const body = cortiVanillaBackground(parent, type);
  cortiSlot(body, 56, 17, slots?.[0], '原料');
  cortiSlot(body, 56, 53, slots?.[1], '燃料');
  cortiSlot(body, 116, 35, slots?.[2], '产物');
  cortiPlayerRows(body, slots, container.inventoryStart, container.hotbarStart);
  const progress = container.furnace || {};
  cortiFurnaceProgress(body, type, 'lit_progress', 56, 36, 14, 14, progress.burn, true);
  cortiFurnaceProgress(body, type, 'burn_progress', 79, 34, 24, 16, progress.cook, false);
}

function cortiFurnaceProgress(parent, type, sprite, x, y, width, height, fraction, vertical) {
  if (!Number.isFinite(fraction) || fraction <= 0) return;
  const clip = document.createElement('div');
  clip.className = 'corti-menu-progress';
  clip.style.left = `${x * 2}px`;
  clip.style.top = `${y * 2}px`;
  clip.style.width = `${width * 2}px`;
  clip.style.height = `${height * 2}px`;
  const image = document.createElement('span');
  image.style.backgroundImage = `url("/textures/gui/sprites/container/${type}/${sprite}.png")`;
  image.style.backgroundSize = `${width * 2}px ${height * 2}px`;
  image.style.width = `${width * 2}px`;
  image.style.height = `${height * 2}px`;
  image.style.clipPath = vertical
    ? `inset(${Math.round((1 - fraction) * 100)}% 0 0 0)`
    : `inset(0 ${Math.round((1 - fraction) * 100)}% 0 0)`;
  clip.append(image);
  parent.append(clip);
}

function cortiRenderCrafting(parent, container) {
  const body = cortiVanillaBackground(parent, 'crafting_table');
  const slots = container.slots;
  for (let i = 0; i < 9; i++) cortiSlot(body, 30 + (i % 3) * 18, 17 + Math.floor(i / 3) * 18, slots?.[i + 1], '合成');
  cortiSlot(body, 124, 35, slots?.[0], '合成结果');
  cortiPlayerRows(body, slots, container.inventoryStart, container.hotbarStart);
}

function cortiRenderGenericContainer(parent, container) {
  const body = document.createElement('div');
  body.className = 'corti-menu-generic';
  const slots = container.slots || [];
  const count = Math.max(0, Math.min(54, Number(container.containerCount) || 0));
  const sections = [
    { title: '容器', start: 0, count },
    { title: '背包', start: container.inventoryStart, count: 27 },
    { title: '快捷栏', start: container.hotbarStart, count: 9 },
  ];
  for (const section of sections) {
    const label = document.createElement('h3');
    label.className = 'corti-menu-section';
    label.textContent = section.title;
    body.append(label);
    const grid = document.createElement('div');
    grid.className = 'corti-menu-grid';
    for (let i = 0; i < section.count; i++) {
      const slot = cortiSlot(grid, 0, 0, slots?.[section.start + i], `${section.title} ${i + 1}`);
      slot.style.left = '';
      slot.style.top = '';
    }
    body.append(grid);
  }
  parent.append(body);
}

function cortiDrawMinimap() {
  const canvas = document.querySelector('#corti-minimap canvas');
  const data = cortiPanelMap;
  if (!canvas || !data) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = data.radius * 2 + 1;
  const tile = canvas.width / size;
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    ctx.fillStyle = cortiTerrainColors[data.cells[z * size + x]] || cortiTerrainColors.X;
    ctx.fillRect(x * tile, z * tile, Math.ceil(tile), Math.ceil(tile));
  }
  const position = cortiPanelAvatar?.entity?.pos || cortiPanelAvatar?.entity?.position;
  const marker = (x, z, color, radius) => {
    const px = (x - data.centerX + data.radius + .5) * tile;
    const pz = (z - data.centerZ + data.radius + .5) * tile;
    if (px < 0 || pz < 0 || px > canvas.width || pz > canvas.height) return;
    ctx.fillStyle = '#152d35';
    ctx.beginPath(); ctx.arc(px, pz, radius + 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(px, pz, radius, 0, Math.PI * 2); ctx.fill();
  };
  for (const entity of entityCache.values()) {
    if (!entity || entity.isSelf || entity.id === cortiPanelAvatar?.entity?.id) continue;
    const pos = entity.pos || entity.position;
    if (!pos) continue;
    marker(pos.x, pos.z, entity.name === 'player' ? '#85d8f9' : '#f6d380', 2.5);
  }
  if (position) {
    const px = (position.x - data.centerX + data.radius + .5) * tile;
    const pz = (position.z - data.centerZ + data.radius + .5) * tile;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate((Number(cortiPanelAvatar.entity.yaw) || 0) + Math.PI);
    ctx.fillStyle = '#162c2d';
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 7); ctx.lineTo(0, 4); ctx.lineTo(-7, 7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#faf7dd';
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 5); ctx.lineTo(0, 2); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  const caption = document.querySelector('[data-map-caption]');
  if (caption) caption.textContent = `${data.dimension.replace(/^minecraft:/, '')} · ${Math.floor(position?.x ?? data.centerX)}, ${Math.floor(position?.z ?? data.centerZ)} · N↑`;
}

function cortiRenderMana() {
  const root = document.getElementById('corti-skills');
  if (!root) return;
  const mana = root.querySelector('[data-mana]');
  const status = root.querySelector('[data-skill-status]');
  const data = cortiPanelSkills;
  const hasMana = Number.isFinite(data?.mana?.current) && Number.isFinite(data?.mana?.max);
  const stale = hasMana && Number.isFinite(data?.observedAt)
    && Date.now() - data.observedAt > 10_000;
  mana.textContent = stale ? '魔力待同步' : hasMana
    ? `魔力 ${Math.round(data.mana.current)}/${Math.round(data.mana.max)}` : '魔力未同步';
  const manaFill = root.querySelector('[data-mana-fill]');
  if (manaFill) manaFill.style.width = !stale && hasMana && data.mana.max > 0
    ? `${Math.max(0, Math.min(100, data.mana.current / data.mana.max * 100))}%` : '0%';
  status.textContent = stale ? `上次读数 ${Math.round(data.mana.current)}/${Math.round(data.mana.max)} · 等待服务端更新`
    : !data ? '暂无服务端技能数据' : data.source === 'chat'
      ? '最近魔力回执 · 技能列表未同步' : `${data.skills.length} 项技能 · ${data.abilities?.length || 0} 项能力`;
}

function cortiRenderSkills() {
  const root = document.getElementById('corti-skills');
  if (!root) return;
  cortiRenderMana();
  const list = root.querySelector('[data-skill-list]');
  const abilities = root.querySelector('[data-ability-list]');
  const data = cortiPanelSkills;
  list.replaceChildren();
  for (const skill of data?.skills || []) {
    const row = document.createElement('div');
    row.className = 'corti-skill';
    const name = document.createElement('span');
    name.textContent = `${skill.name} `;
    const level = document.createElement('strong');
    level.textContent = `Lv.${skill.level}`;
    row.append(name, level);
    if (Number.isFinite(skill.xp) && Number.isFinite(skill.requiredXp) && skill.requiredXp > 0) {
      const track = document.createElement('div');
      track.className = 'corti-skill-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.max(0, Math.min(100, skill.xp / skill.requiredXp * 100))}%`;
      track.append(fill);
      row.append(track);
      row.title = `${skill.xp}/${skill.requiredXp} XP`;
    }
    list.append(row);
  }
  abilities.replaceChildren();
  for (const ability of data?.abilities || []) {
    const row = document.createElement('div');
    row.className = 'corti-ability';
    const name = document.createElement('span');
    name.textContent = ability.name;
    const detail = document.createElement('small');
    const level = Number.isFinite(ability.level) ? `Lv.${ability.level}` : '';
    const cooldown = Number.isFinite(ability.cooldownMs) && ability.cooldownMs > 0
      ? `${Math.ceil(ability.cooldownMs / 1000)}s` : '';
    detail.textContent = [level, cooldown].filter(Boolean).join(' · ');
    row.append(name, detail);
    abilities.append(row);
  }
}

cortiInstallPanels(socket);
