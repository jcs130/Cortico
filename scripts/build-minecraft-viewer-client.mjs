/** Build the locally owned modern viewer source against Minecraft 1.20.6 data. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, copyFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildBiomeMesherWorker } from './build-minecraft-viewer-biome-worker.mjs'
import { patchAvatarMotion, patchRendererAvatar } from './minecraft-viewer-avatar-patch.mjs'

const [sourceArg, outputArg] = process.argv.slice(2)
if (!sourceArg || !outputArg) {
  console.error('用法：node scripts/build-minecraft-viewer-client.mjs <modern-viewer 源码包> <输出包目录>')
  process.exit(2)
}
const sourceRoot = path.resolve(sourceArg)
const outputRoot = path.resolve(outputArg)
const renderAssets = path.join(outputRoot, 'render-assets')
const sourceManifest = JSON.parse(await readFile(path.join(outputRoot, 'public', 'asset-source.json'), 'utf8'))
if (sourceManifest.minecraftVersion !== '1.20.6' || !sourceManifest.clientJarSha256) {
  throw Error('请先从 1.20.6 客户端 JAR 导出资源')
}
const replacements = {
  'blockStatesModels.json': 'blockStatesModels.json',
  'blocksAtlases.json': 'blocksAtlases.json',
  'itemsAtlases.json': 'itemsAtlases.json',
  'itemDefinitions.json': 'itemDefinitions.json',
  'blocksAtlasLatest.png': 'blocksAtlasLatest.png',
  'blocksAtlasLegacy.png': 'blocksAtlasLatest.png',
  'itemsAtlasLatest.png': 'itemsAtlasLatest.png',
  'itemsAtlasLegacy.png': 'itemsAtlasLatest.png',
}
for (const name of new Set(Object.values(replacements))) {
  if (!(await stat(path.join(renderAssets, name)).catch(() => null))?.isFile()) {
    throw Error(`缺少从 1.20.6 客户端 JAR 导出的渲染资源：${name}`)
  }
}
const sourceRequire = createRequire(path.join(sourceRoot, 'package.json'))
const { build } = sourceRequire('esbuild')
const { polyfillNode } = sourceRequire('esbuild-plugin-polyfill-node')
const dataPaths = sourceRequire('minecraft-data/minecraft-data/data/dataPaths.json').pc['1.20.6']
if (!dataPaths) throw Error('minecraft-data 不支持 1.20.6')

const fields = ['attributes', 'blocks', 'blockCollisionShapes', 'biomes', 'effects', 'items',
  'enchantments', 'instruments', 'materials', 'language', 'entities', 'version', 'foods', 'particles', 'tints']
const jsonModule = (field) => sourceRequire.resolve(`minecraft-data/minecraft-data/data/${dataPaths[field]}/${field}.json`)
const alias = [
  `const mcDataToNode = require(${JSON.stringify(sourceRequire.resolve('minecraft-data/lib/loader.js'))});`,
  ...fields.map((field) => `const ${field} = require(${JSON.stringify(jsonModule(field))});`),
  `const legacyPc = require(${JSON.stringify(sourceRequire.resolve('minecraft-data/minecraft-data/data/pc/common/legacy.json'))});`,
  `const protocolVersions = require(${JSON.stringify(sourceRequire.resolve('minecraft-data/minecraft-data/data/pc/common/protocolVersions.json'))});`,
  `const createSupportFeature = require(${JSON.stringify(sourceRequire.resolve('minecraft-data/lib/supportsFeature.js'))});`,
  `const data = mcDataToNode({ ${fields.join(', ')} });`,
  `data.type = 'pc';`,
  `const protocolVersion = protocolVersions.find(row => row.minecraftVersion === '1.20.6');`,
  `const compareTo = other => { const row = protocolVersions.find(entry => entry.minecraftVersion === String(other));
    return protocolVersion?.dataVersion !== undefined && row?.dataVersion !== undefined
      ? protocolVersion.dataVersion - row.dataVersion : compareVersions('1.20.6', other); };`,
  `data.version = { ...version, dataVersion: protocolVersion?.dataVersion, type: 'pc', majorVersion: '1.20',
    minecraftVersion: '1.20.6', '>=': other => compareTo(other) >= 0, '>': other => compareTo(other) > 0,
    '<=': other => compareTo(other) <= 0, '<': other => compareTo(other) < 0, '==': other => compareTo(other) === 0 };`,
  `data.isNewerOrEqualTo = other => compareVersions('1.20.6', other) >= 0;`,
  `data.isOlderThan = other => compareVersions('1.20.6', other) < 0;`,
  `data.supportFeature = createSupportFeature(data.version, protocolVersions);`,
  `function MinecraftData() { return data; }`,
  `MinecraftData.legacy = { pc: legacyPc, bedrock: { blocks: {}, items: {} } };`,
  `MinecraftData.versions = { pc: protocolVersions, bedrock: [] };`,
  `module.exports = MinecraftData;`,
  `function compareVersions(left, right) { const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const delta = (a[i] || 0) - (b[i] || 0); if (delta) return delta; }
    return 0; }`,
].join('\n')

const temp = await mkdtemp(path.join(tmpdir(), 'cortico-modern-viewer-'))
const aliasFile = path.join(temp, 'minecraft-data-1.20.6.cjs')
await writeFile(aliasFile, alias)
const clientFile = path.join(sourceRoot, 'src', 'modern-viewer', 'client.js')
const clientSource = await readFile(clientFile, 'utf8')
let correctedEntitySkeleton = false
let correctedAvatarMotion = false
const itemIconSource = await readFile(new URL('./minecraft-viewer-item-icon.js', import.meta.url), 'utf8')
const hudSource = await readFile(new URL('./minecraft-viewer-hud.js', import.meta.url), 'utf8')
const motionSource = await readFile(new URL('./minecraft-viewer-motion.js', import.meta.url), 'utf8')
const weaponMotionSource = await readFile(new URL('./minecraft-viewer-weapon-motion.js', import.meta.url), 'utf8')
const shieldSource = await readFile(new URL('./minecraft-viewer-shield.js', import.meta.url), 'utf8')
const entityMotionSource = await readFile(new URL('./minecraft-viewer-entity-motion.js', import.meta.url), 'utf8')
const avatarIntegritySource = await readFile(new URL('./minecraft-viewer-avatar-integrity.js', import.meta.url), 'utf8')
const thirdPersonSwingSource = await readFile(new URL('./minecraft-viewer-third-person-swing.js', import.meta.url), 'utf8')
const droppedItemsSource = await readFile(new URL('./minecraft-viewer-dropped-items.js', import.meta.url), 'utf8')
const castSource = await readFile(new URL('./minecraft-viewer-cast.js', import.meta.url), 'utf8')
const combatSource = await readFile(new URL('./minecraft-viewer-combat.js', import.meta.url), 'utf8')
const eventsSource = await readFile(new URL('./minecraft-viewer-events.js', import.meta.url), 'utf8')
const particleSource = await readFile(new URL('./minecraft-viewer-particles.js', import.meta.url), 'utf8')
const presentationSource = await readFile(new URL('./minecraft-viewer-presentation.js', import.meta.url), 'utf8')
const soundSource = await readFile(new URL('./minecraft-viewer-sound.js', import.meta.url), 'utf8')
const biomeStyleSource = await readFile(new URL('./minecraft-viewer-biome-style.js', import.meta.url), 'utf8')
const panelsSource = await readFile(new URL('./minecraft-viewer-panels.js', import.meta.url), 'utf8')
const sheepSource = await readFile(new URL('./minecraft-viewer-sheep.js', import.meta.url), 'utf8')
const paintingFile = path.join(sourceRoot, 'src', 'modern-viewer', 'painting-variants.js')
const paintingSource = await readFile(paintingFile, 'utf8')
const paintingRecords = JSON.parse(await readFile(path.join(renderAssets, 'painting-records.json'), 'utf8'))
const changedPaintings = paintingSource.replace(/const records = \[[\s\S]*?\n\];/, `const records = ${JSON.stringify(paintingRecords)};`)
if (changedPaintings === paintingSource) throw Error('modern viewer 画作表格式已变化')
const changedClient = clientSource
  .replace('  for (const event of pendingChunks.values()) worldView.emit(event.type === "load" ? "loadChunk" : "unloadChunk", event.data);\n  pendingChunks.clear();\n  if (pendingBlockEntities) worldView.emit("blockEntities", pendingBlockEntities);',
    '  if (pendingBlockEntities) worldView.emit("blockEntities", pendingBlockEntities);\n  for (const event of pendingChunks.values()) worldView.emit(event.type === "load" ? "loadChunk" : "unloadChunk", event.data);\n  pendingChunks.clear();')
  .replace('String(version || "1.21.1")', 'String(version || "1.20.6")')
  .replace('"/textures/1.21.1/entity/villager"', '"/textures/1.20.6/entity/villager"')
  // The OBJ uses bottom-origin UVs (face V 0.72–0.88). Three must flip the
  // top-origin 1.20.6 PNG before upload or the face samples transparent legs.
  .replace('  texture.flipY = false;\n  texture.generateMipmaps = false;',
    '  texture.flipY = true;\n  texture.generateMipmaps = false;')
  .replace('    textureHeight: Number.isFinite(textureHeight) ? textureHeight : null,\n    partCounts,',
    '    textureHeight: Number.isFinite(textureHeight) ? textureHeight : null,\n    textureFlippedY: texture?.flipY === true,\n    partCounts,')
  .replace('    && textureHeight === 64\n    && missingParts.length === 0;',
    '    && textureHeight === 64\n    && texture.flipY === true\n    && missingParts.length === 0;')
  .replace('starfield: true,', 'starfield: false,')
  // The reference viewer feeds this value directly into camera displacement
  // (up to 0.9 blocks while sprinting). Keep a subtle first-person stride.
  .replace('  const targetBob = movementState === "NOT_MOVING" ? 0 : movementState === "SPRINTING" ? 0.9 : 0.6;',
    '  const targetBob = movementState === "NOT_MOVING" ? 0 : movementState === "SPRINTING" ? 0.07 : 0.045;')
  .replace('  applyAvatarState();\n  renderInventoryHud();\n  renderMotionHud();',
    '  applyAvatarState();\n  renderCortiSurvivalHud(pendingAvatarState);\n  renderInventoryHud();\n  renderMotionHud();')
  .replace('  updateHandItem("main", equipment?.[0] ?? selectedHotbarItem(state));\n  updateHandItem("off", equipment?.[1]);',
    '  updateHandItem("main", Array.isArray(state.hotbar) ? selectedHotbarItem(state) : equipment?.[0]);\n' +
    '  updateHandItem("off", Object.hasOwn(state, "offhand") ? state.offhand : equipment?.[1]);')
  .replace('if (usesWorldAvatar) handleEntity(entity, entityCache.has(String(entity.id)));',
    'if (usesWorldAvatar) handleEntity(entity, !cortiOwnEquipmentChanged(entity) && entityCache.has(String(entity.id)));')
  .replace('  entityCache.set(id, normalized);',
    '  entityCache.set(id, normalized);\n  cortiPruneSelfEntities(normalized);')
  .replace('  renderMotionHud();\n}\n\nfunction applyEntityAnimation',
    '  cortiAlignAvatarArmor(state.entity);\n  cortiSyncAvatarShield(state.entity, state.offhand ?? equipment?.[1]);\n  renderMotionHud();\n}\n\nfunction applyEntityAnimation')
  .replace('const DUNGEON_OCCLUSION_CUT_HEIGHT = 0.28;', 'const DUNGEON_OCCLUSION_CUT_HEIGHT = 2;')
  .replace('if (!camera || !sceneOrigin || typeof collisionCache?.isSolidBlock !== "function") {',
    'if (!camera || !sceneOrigin) {')
  .replace('  if (dungeonOcclusionState.active) {\n    applyDungeonCutaway({',
    '  if (isDungeonView) {\n    applyDungeonCutaway({')
  .replace('cutoffWorldY: avatar.y + DUNGEON_OCCLUSION_CUT_HEIGHT,',
    'cutoffWorldY: Math.floor(avatar.y) + DUNGEON_OCCLUSION_CUT_HEIGHT,')
  .replace('u_lanternCutawayEnabled > 0.5 && lanternInSightCorridor &&',
    'u_lanternCutawayEnabled > 0.5 &&')
  .replace('  const key = item ? `${item.name || ""}:${item.type ?? item.itemId ?? ""}:${item.metadata ?? ""}` : "empty";',
    '  const key = item ? `${item.name || ""}:${item.type ?? item.itemId ?? ""}:${item.metadata ?? ""}:${item.enchanted === true}` : "empty";')
  .replace('socket.on("entityAnimation", (event) => applyEntityAnimation(event));',
    'socket.on("digProgress", (event) => cortiApplyDigProgress(event));\n' +
    'socket.on("entityAnimation", (event) => applyEntityAnimation(event));')
  .replace('socket.on("entity", (update) => handleEntity(update, false));',
    'socket.on("biome", (event) => cortiSetBiome(event));\n' +
    'socket.on("entity", (update) => handleEntity(update, false));')
  .replaceAll('    maybeApplyVillagerAppearance(entity);',
    '    maybeApplyVillagerAppearance(entity);\n    cortiApplySheepAppearance(entity);')
  .replace('  maybeApplyVillagerAppearance(normalized);',
    '  maybeApplyVillagerAppearance(normalized);\n  cortiApplySheepAppearance(normalized);')
  .replace('    viewer.backend?.backendMethods?.changeHandSwingingState?.(true, event.hand === "left");\n    clearTimeout(handSwingTimer);\n    handSwingTimer = setTimeout(() => {\n      viewer?.backend?.backendMethods?.changeHandSwingingState?.(false, event.hand === "left");\n    }, 280);',
    '    cortiApplyFirstPersonSwing(event);')
  .replace('    rig.trigger("swing", {\n      hand: event.hand === "left" ? "left" : "right",',
    '    rig.trigger("swing", {\n      hand: event.hand === "left" ? "left" : "right",\n' +
    '      style: String((targetId === String(pendingAvatarState?.entity?.id ?? "") ? pendingAvatarState?.entity : entityCache.get(targetId))?.equipment?.[0]?.name ?? "").replace(/^minecraft:/, "").endsWith("_sword") ? "sword" : null,')
  .replace('    enhanceRendererQuality();',
    '    enhanceRendererQuality();\n    cortiInitializeBiomeStyle();\n    cortiInitializeDroppedItems();\n    cortiInitializeWeaponMotion();\n    cortiInitializeShield();')
  .replace('function applyPosition(instant = false) {', 'function applyPosition(instant = false, animatedFrame = false) {')
  .replace('  const { pos, yaw, pitch } = latestPosition;\n  if (usesWorldAvatar) {',
    '  const cameraPose = cortiCameraPose(latestPosition, instant);\n  const { pos, yaw, pitch } = cameraPose;\n  if (!cameraPose.settled) scheduleCortiCameraFrame();\n  if (usesWorldAvatar) {')
  .replace('      { instant },\n    );\n  }\n  worldView.emit("chunkPosUpdate", { pos });',
    '      { instant: true },\n    );\n  }\n  if (!animatedFrame) worldView.emit("chunkPosUpdate", { pos: latestPosition.pos });')
  .replace('    pendingPlayerEntity = { ...pendingPlayerEntity, pos, position: pos, yaw, pitch };',
    '    pendingPlayerEntity = { ...pendingPlayerEntity, pos: latestPosition.pos, position: latestPosition.pos, yaw: latestPosition.yaw, pitch: latestPosition.pitch };')
  .replace('    pitch: finiteOr(data?.pitch, usesWorldAvatar ? -0.22 : 0),\n  };',
    '    pitch: finiteOr(data?.pitch, usesWorldAvatar ? -0.22 : 0),\n    teleport: data?.teleport === true,\n  };')
  .replace('    installManualControls();', '    // Cortico 的网页画面只读，不安装游戏接管控制。')
  .replace('    installDungeonInteractions();', '    // 只读画面不显示可操作交互。')
  .replace('    installDungeonContextMenu();', '    // 只读画面不显示游戏操作菜单。')
  .replaceAll('installNpcGameplay();', '/* Cortico 的网页画面无参考项目 NPC 操作层。 */')
  .replace('地牢 2.5D 视角；悬停识别对象，接管后点击地面移动，右键或长按目标选择详情、走近、攻击或使用，滚轮缩放', '地牢 2.5D 只读观察视角；滚轮缩放')
  .replaceAll('灯守', '玩家')
  .replace(/function updateManualHelp\(\) \{[\s\S]*?\n\}\n\nfunction postToDashboard/, `function updateManualHelp() {
  const help = document.querySelector(".viewer-help");
  if (help) help.textContent = viewMode === "first"
    ? "实时第一人称画面 · 只读"
    : "实时画面 · 可移动观察镜头 · 不控制游戏角色";
}

function postToDashboard`)
if (changedClient === clientSource || changedClient.includes('String(version || "1.21.1")')
    || !clientSource.includes('starfield: true,')
    || !changedClient.includes('  const targetBob = movementState === "NOT_MOVING" ? 0 : movementState === "SPRINTING" ? 0.07 : 0.045;')
    || !clientSource.includes('  applyAvatarState();\n  renderInventoryHud();\n  renderMotionHud();')
    || !changedClient.includes('const cameraPose = cortiCameraPose(latestPosition, instant);')
    || !changedClient.includes('teleport: data?.teleport === true,')
    || !clientSource.includes('socket.on("viewerReset"')
    || !changedClient.includes('socket.on("viewerReset"')
    || !changedClient.includes('socket.on("digProgress"')
    || !changedClient.includes('socket.on("biome"')
    || !changedClient.includes('Array.isArray(state.hotbar) ? selectedHotbarItem(state) : equipment?.[0]')
    || !changedClient.includes('cortiOwnEquipmentChanged(entity)')
    || !changedClient.includes('  cortiPruneSelfEntities(normalized);')
    || !changedClient.includes('  cortiAlignAvatarArmor(state.entity);\n  cortiSyncAvatarShield(state.entity, state.offhand ?? equipment?.[1]);')
    || !changedClient.includes('const DUNGEON_OCCLUSION_CUT_HEIGHT = 2;')
    || !changedClient.includes('cutoffWorldY: Math.floor(avatar.y) + DUNGEON_OCCLUSION_CUT_HEIGHT,')
    || changedClient.includes('u_lanternCutawayEnabled > 0.5 && lanternInSightCorridor &&')
    || !changedClient.includes('${item.enchanted === true}` : "empty";')
    || !changedClient.includes('    cortiApplySheepAppearance(entity);')
    || !changedClient.includes('  cortiApplySheepAppearance(normalized);')
    || !changedClient.includes('    cortiApplyFirstPersonSwing(event);')
    || !changedClient.includes('style: String((targetId === String(pendingAvatarState?.entity?.id ?? "")')
    || !changedClient.includes('    cortiInitializeWeaponMotion();\n    cortiInitializeShield();')
    || !clientSource.includes('  texture.flipY = false;\n  texture.generateMipmaps = false;')
    || !changedClient.includes('  texture.flipY = true;\n  texture.generateMipmaps = false;')
    || !changedClient.includes('    textureFlippedY: texture?.flipY === true,')
    || !changedClient.includes('    && texture.flipY === true\n    && missingParts.length === 0;')
    || !changedClient.includes('    cortiInitializeBiomeStyle();\n    cortiInitializeDroppedItems();')
    || !changedClient.includes('  if (pendingBlockEntities) worldView.emit("blockEntities", pendingBlockEntities);\n  for (const event of pendingChunks.values())')) {
  throw Error('modern viewer 源码版本锚点已变化')
}
const clientWithHud = `import * as CortiThree from "three";\n${changedClient}\nglobalThis.THREE = CortiThree;\n${itemIconSource}\n${hudSource}\n${motionSource}\n${weaponMotionSource}\n${shieldSource}\n${entityMotionSource}\n${avatarIntegritySource}\n${droppedItemsSource}\n${biomeStyleSource}\n${panelsSource}\n${sheepSource}\n${castSource}\n${combatSource}\n${eventsSource}\n${particleSource}\n${presentationSource}\n${soundSource}\n`

await mkdir(path.join(outputRoot, 'dist'), { recursive: true })
await mkdir(path.join(outputRoot, 'public'), { recursive: true })
const buildResult = await build({
  entryPoints: [clientFile], bundle: true, define: { 'process.env.NODE_ENV': '"production"' },
  format: 'esm', legalComments: 'none', loader: { '.png': 'dataurl' }, minify: true,
  outfile: path.join(outputRoot, 'dist', 'modern-viewer.js'), platform: 'browser',
  plugins: [
    { name: 'cortico-minecraft-1.20.6', setup(context) {
      context.onResolve({ filter: /^minecraft-data$/ }, () => ({ path: aliasFile }))
      context.onResolve({ filter: /^mc-assets\/dist\// }, ({ path: request }) => {
        const file = request.slice('mc-assets/dist/'.length)
        const legacyTexture = file.match(/^other-textures\/(?:latest|1\.21\.2)\/(.+\.png)$/)
        if (legacyTexture) {
          const local = path.join(outputRoot, 'public', 'textures', '1.20.6', legacyTexture[1])
          return { path: local }
        }
        return replacements[file] ? { path: path.join(renderAssets, replacements[file]) } : undefined
      })
      context.onResolve({ filter: /^valtio\/utils$/ }, () => ({ path: path.join(sourceRoot, 'src', 'modern-viewer', 'valtio-utils-shim.js') }))
      context.onResolve({ filter: /^valtio$/ }, () => ({ path: path.join(sourceRoot, 'node_modules', 'valtio', 'esm', 'vanilla.mjs') }))
      context.onLoad({ filter: /[\\/]modern-viewer[\\/]client\.js$/ }, () => ({ contents: clientWithHud, loader: 'js', resolveDir: path.dirname(clientFile) }))
      context.onLoad({ filter: /[\\/]modern-viewer[\\/]avatar-motion\.js$/ }, async ({ path: file }) => {
        correctedAvatarMotion = true
        return { contents: patchAvatarMotion(await readFile(file, 'utf8'), thirdPersonSwingSource),
          loader: 'js', resolveDir: path.dirname(file) }
      })
      context.onLoad({ filter: /[\\/]minecraft-renderer[\\/]dist[\\/]minecraft-renderer\.js$/ }, async ({ path: file }) => {
        const original = await readFile(file, 'utf8')
        const anchor = 'for(let _ of t.bones)_.parent&&c[_.parent]?c[_.parent].add(c[_.name]):p.push(c[_.name]);'
        const glintAnchor = 'this.lastUpdate&&s-this.lastUpdate>50&&this.replaceItemModel(this.lastHeldItem)'
        if (!original.includes(anchor) || !original.includes(glintAnchor)) throw Error('minecraft-renderer 源码锚点已变化')
        correctedEntitySkeleton = true
        const corrected = patchRendererAvatar(original.replace(anchor, `for(let _ of t.bones)if(_.parent&&c[_.parent]){
          let pivot=t.bones.find(entry=>entry.name===_.parent)?.pivot;
          if(pivot){c[_.name].position.x-=pivot[0];c[_.name].position.y-=pivot[1];c[_.name].position.z-=pivot[2]}
          c[_.parent].add(c[_.name])
        }else p.push(c[_.name]);`).replace(glintAnchor,
          'this.lastUpdate&&s-this.lastUpdate>50&&(!this.lastHeldItem.fullItem?.enchanted||this.worldRenderer.playerStateReactive.itemUsageTicks>0)&&this.replaceItemModel(this.lastHeldItem)'))
        return { contents: corrected, loader: 'js', resolveDir: path.dirname(file) }
      })
      context.onLoad({ filter: /[\\/]modern-viewer[\\/]painting-variants\.js$/ }, () => ({ contents: changedPaintings, loader: 'js', resolveDir: path.dirname(paintingFile) }))
      context.onLoad({ filter: /[\\/]modern-viewer[\\/]player-skins\.js$/ }, () => ({
        contents: `import texture from ${JSON.stringify(path.join(outputRoot, 'public', 'textures', '1.20.6', 'entity', 'player', 'wide', 'steve.png'))};
          export const DEFAULT_PLAYER_SKIN_ID = 'minecraft-default';
          export const PLAYER_SKINS = Object.freeze([{ id: 'minecraft-default', label: '原版角色', model: 'classic', texture }]);
          export const isPlayerSkinId = value => value === 'minecraft-default';
          export const resolvePlayerSkin = () => PLAYER_SKINS[0];`,
        loader: 'js', resolveDir: sourceRoot,
      }))
      context.onLoad({ filter: /[\\/]modern-viewer[\\/]player-models\.js$/ }, () => ({
        contents: `export const DEFAULT_PLAYER_MODEL_ID = 'minecraft-classic';
          export const PLAYER_MODELS = Object.freeze([{ id: 'minecraft-classic', label: '原版方块人',
            kind: 'minecraft-classic', assetId: null, presentation: 'classic', accent: 'pixel' }]);
          export const isPlayerModelId = value => value === 'minecraft-classic';
          export const resolvePlayerModel = () => PLAYER_MODELS[0];`,
        loader: 'js', resolveDir: sourceRoot,
      }))
    } },
    polyfillNode({ globals: { buffer: true, process: false } }),
  ],
  metafile: true, sourcemap: false, target: ['chrome103', 'edge103', 'firefox102', 'safari15.4'],
})
const inputs = Object.keys(buildResult.metafile.inputs).map(name => name.replaceAll('\\', '/'))
if (!correctedEntitySkeleton) throw Error('minecraft-renderer 骨架修正未进入浏览器构建')
if (!correctedAvatarMotion) throw Error('第三人称挥剑动作未进入浏览器构建')
for (const filename of ['blockStatesModels.json', 'blocksAtlases.json', 'itemsAtlases.json',
  'blocksAtlasLatest.png', 'itemsAtlasLatest.png', 'itemDefinitions.json']) {
  if (!inputs.some(name => name.endsWith(`/render-assets/${filename}`))) {
    throw Error(`渲染 bundle 未使用 1.20.6 导出文件：${filename}`)
  }
}
if (inputs.some(name => /mc-assets\/dist\/(?:blocksAtlases|itemsAtlases|blockStatesModels|itemDefinitions)\.json$/.test(name))) {
  throw Error('渲染 bundle 混入了 mc-assets 自带的其他版本数据')
}

for (const name of ['mesherWasm.js', 'threeWorker.js', 'minecraft-renderer.js', 'minecraft-renderer.js.meta.json']) {
  await copyFile(sourceRequire.resolve(`minecraft-renderer/dist/${name}`), path.join(outputRoot, 'public', name))
}
const biomeWorker = await buildBiomeMesherWorker(sourceRoot, outputRoot, aliasFile)
await mkdir(path.join(outputRoot, 'public', 'character-assets'), { recursive: true })
await writeFile(path.join(outputRoot, 'public', 'character-assets', 'manifest.json'), '{"schemaVersion":1,"assets":[]}\n')
const browserBundleSha256 = createHash('sha256').update(
  await readFile(path.join(outputRoot, 'dist', 'modern-viewer.js'))).digest('hex')
const mesherSha256 = createHash('sha256').update(await readFile(biomeWorker.outputFile)).digest('hex')
await writeFile(path.join(outputRoot, 'viewer-client.json'), `${JSON.stringify({
  minecraftVersion: '1.20.6', clientJarSha256: sourceManifest.clientJarSha256,
  browserBundleSha256, mesherSha256, biomeCount: biomeWorker.biomeCount,
})}\n`)
console.log(`1.20.6 modern viewer 已生成：${outputRoot}`)
