/** Read-only modern Minecraft picture served from the current Mineflayer bot. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Server as SocketServer, type Socket } from 'socket.io';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { biomeIdMap, remapViewerChunkBiomes } from './viewer-biome.ts';
import { viewerLight } from './viewer-light.ts';
import { minimapSnapshot } from './viewer-minimap.ts';
import { manaSnapshotFromText, parseSkillsPayload, VIEWER_STATE_CHANNEL, viewerBossBars, viewerItem, windowSnapshot, type ViewerSkills } from './viewer-state.ts';
import { observeViewerArmAnimation, observeViewerRangedUse, observeViewerShieldUse, viewerMovementState, viewerSheepAppearance } from './viewer-entity-state.ts';
import { observeViewerCastCommands, viewerCastCommand, viewerCastResult, type ViewerCastCommand } from './viewer-cast.ts';
import { parseViewerCombatHit } from './viewer-combat.ts';
import { viewerBlockEntities, viewerChunkBlockEntities } from './viewer-block-entities.ts';
import { observeViewerBossBars } from './viewer-boss-bars.ts';
import { parseViewerCustomEvent, viewerExplosion, viewerPacketLane, viewerParticle, viewerWorldEvent } from './viewer-presentation.ts';
import { ViewerAdvancementTracker } from './viewer-advancements.ts';
import { viewerRenderableMetadata } from './viewer-render-metadata.ts';
import { minecraftTextComponent } from './text-component.ts';
import type { EventEmitter } from 'node:events';
import { isRaining } from './terrain.ts';
export { viewerItem } from './viewer-state.ts';

export function viewerMessageKind(message: { translate?: string; toString(): string }, position: string): string | null {
  if (position !== 'chat' && position !== 'system') return null;
  if (message.translate === 'commands.message.display.outgoing') return null;
  if (position === 'system' && /^(?:MC_[A-Z0-9_]+(?:\s|$)|\{\s*"(?:schemaVersion|action|type)"\s*:)/.test(message.toString().trimStart())) return null;
  return message.translate === 'commands.message.display.incoming' ? 'whisper'
    : message.translate === 'chat.type.advancement' ? 'advancement' : position;
}

const require = createRequire(import.meta.url);
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView.js') as {
  WorldView: new (world: unknown, distance: number, position: unknown, socket: Socket) => WorldView;
};
const vanillaBiomes = (require('minecraft-data')('1.20.6') as {
  biomesArray: Array<{ id: number; name: string }>;
}).biomesArray;
const plainsBiomeId: number = (() => {
  const id = vanillaBiomes.find(biome => biome.name === 'plains')?.id;
  if (id === undefined) throw Error('1.20.6 群系列表缺少 plains');
  return id;
})();

const VIEW_DISTANCE = 4;
const MANA_CSS = `.corti-mana-bar{height:5px;margin-top:7px;background:#294852;border-radius:5px;overflow:hidden}.corti-mana-bar span{display:block;height:100%;width:0;background:linear-gradient(90deg,#447acb,#8de9ff);box-shadow:0 0 9px #87dafa;transition:width .3s ease}`;
const COMBAT_CSS = `.corti-combat-floats{position:fixed;inset:0;z-index:10;pointer-events:none;overflow:hidden}.corti-combat-float{position:absolute;color:#fff7ee;font:800 23px/1.1 system-ui;text-shadow:0 2px 2px #18111b,0 0 8px #161322;white-space:nowrap;transform:translate(-50%,-50%);animation:corti-damage-number 1.15s ease-out both}.corti-combat-float.is-critical{color:#ffdf46;font-size:30px;font-weight:1000;text-shadow:0 2px 2px #422600,0 0 13px #ffb328}@keyframes corti-damage-number{0%{opacity:0;transform:translate(-50%,-50%) scale(.75)}16%{opacity:1;transform:translate(-50%,-67%) scale(1.12)}72%{opacity:1}100%{opacity:0;transform:translate(-50%,-320%) scale(.96)}}@media(prefers-reduced-motion:reduce){.corti-combat-float{animation-duration:.7s}}`;
const STATUS_VIGNETTE_CSS = `.corti-status-vignette{position:fixed;inset:0;z-index:2;pointer-events:none;opacity:0;transition:opacity .35s ease;background:radial-gradient(ellipse at center,transparent 40%,#407b2466 77%,#245810aa 100%),radial-gradient(circle at 11% 83%,#98db5b66 0 1.2%,transparent 2.5%),radial-gradient(circle at 85% 19%,#97d85980 0 .8%,transparent 2%);box-shadow:inset 0 0 34px #416b30;mix-blend-mode:screen}.corti-status-vignette.is-poisoned{opacity:1;animation:corti-poison-breathe 2.4s ease-in-out infinite}@keyframes corti-poison-breathe{0%,100%{filter:saturate(.8)}50%{filter:saturate(1.5) brightness(1.12)}}@media(prefers-reduced-motion:reduce){.corti-status-vignette.is-poisoned{animation:none}}`;
const PRESENTATION_CSS = `:root{--mc-viewer-vfx-fire:#ffa05b;--mc-viewer-vfx-arcane:#c5a5ff;--mc-viewer-vfx-life:#a9eeb8;--mc-viewer-vfx-water:#a6e5ff;--mc-viewer-vfx-combat:#fff4af;--mc-viewer-vfx-neutral:#d9e0d7;--mc-viewer-ui-bg:#11242cde;--mc-viewer-ui-border:#b0ccb5a8;--mc-viewer-ui-text:#f3f5f6}body[data-viewer-theme="corti-arcane"]{--mc-viewer-vfx-arcane:#e6a3ff;--mc-viewer-vfx-combat:#ffd580;--mc-viewer-ui-bg:#201a36e8;--mc-viewer-ui-border:#d2a8f0b0;--mc-viewer-ui-text:#fbf1ff}.corti-presentation-toasts{position:fixed;z-index:9;top:14px;left:250px;display:grid;gap:7px;width:min(300px,25vw);pointer-events:none}.corti-presentation-toast{display:grid;gap:2px;padding:9px 12px;border:1px solid var(--mc-viewer-ui-border);border-left:4px solid #b5d8ea;border-radius:7px;background:var(--mc-viewer-ui-bg);box-shadow:0 4px 18px #0008;color:var(--mc-viewer-ui-text);animation:corti-toast-enter .25s ease-out}.corti-presentation-toast strong{font:800 15px/1.3 system-ui}.corti-presentation-toast span{font:12px/1.35 system-ui;overflow-wrap:anywhere}.corti-presentation-toast[data-tone="arcane"]{border-left-color:#d5a6ff}.corti-presentation-toast[data-tone="positive"]{border-left-color:#9be0ac}.corti-presentation-toast[data-tone="warning"]{border-left-color:#f0ce75}.corti-presentation-toast[data-tone="danger"]{border-left-color:#f49a9a}@keyframes corti-toast-enter{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}.corti-effects{position:fixed;z-index:7;right:14px;bottom:66px;display:grid;gap:4px;max-width:220px;max-height:25vh;overflow:hidden;pointer-events:none}.corti-effect{display:flex;align-items:center;gap:5px;min-width:125px;padding:3px 6px;border:1px solid var(--mc-viewer-ui-border);border-radius:5px;background:var(--mc-viewer-ui-bg);color:var(--mc-viewer-ui-text);font:12px/1.2 system-ui}.corti-effect[data-type="bad"]{border-color:#e09c9caf}.corti-effect img{position:static;width:19px;height:19px;image-rendering:pixelated}.corti-effect span{flex:1}.corti-effect small{font:11px monospace}.corti-scoreboard{position:fixed;z-index:7;top:252px;left:14px;width:220px;max-height:min(34vh,300px);overflow:hidden;box-sizing:border-box;padding:8px;border:1px solid var(--mc-viewer-ui-border);border-radius:7px;background:var(--mc-viewer-ui-bg);color:var(--mc-viewer-ui-text);pointer-events:none}.corti-scoreboard>strong{display:block;margin-bottom:5px;font:700 13px system-ui}.corti-scoreboard>div{display:flex;justify-content:space-between;gap:8px;font:11px/1.4 system-ui}.corti-scoreboard b{color:#d6efac}.corti-cooldown{position:absolute;z-index:4;left:4px;right:4px;bottom:2px;background:#1119;pointer-events:none}@media(max-width:900px){.corti-presentation-toasts{left:50%;top:72px;transform:translateX(-50%);width:min(280px,42vw)}.corti-scoreboard{top:180px;width:150px;max-height:26vh}}@media(max-width:420px){.corti-minimap{width:116px}.corti-minimap canvas{width:104px;height:104px}.corti-skills{width:116px}.corti-scoreboard{top:155px;width:116px}.corti-presentation-toasts{top:146px;width:min(210px,70vw)}}@media(prefers-reduced-motion:reduce){.corti-presentation-toast{animation:none}}`;
const THEME_SURFACE_CSS = `.corti-minimap,.corti-skills,.corti-menu{background:var(--mc-viewer-ui-bg);border-color:var(--mc-viewer-ui-border);color:var(--mc-viewer-ui-text)}.corti-night-vision-toggle,.corti-sound-toggle,.corti-inventory-toggle{border-color:var(--mc-viewer-ui-border);color:var(--mc-viewer-ui-text)}`;
const MAX_SESSIONS = 2;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
type ViewerEntity = mineflayer.Bot['entity'];

interface WorldView {
  init(position: unknown): Promise<void>;
  updatePosition(position: unknown): Promise<void>;
  unloadChunk(position: unknown): void;
  listenToBot(bot: mineflayer.Bot): void;
  removeListenersFromBot(bot: mineflayer.Bot): void;
}

export interface ModernViewerHandle {
  url: string;
  close(): Promise<void>;
}

export interface ModernViewerOptions {
  port: number;
  assetsDir: string;
  speakerName?: string;
  agentMana?: () => ViewerSkills['mana'] | undefined;
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minecraft 画面</title><link rel="stylesheet" href="/viewer.css"></head><body data-view-mode="__VIEW_MODE__">
<div class="boot" aria-live="polite">正在载入世界画面…</div>
<nav class="corti-view-switch" aria-label="切换观察视角"><a href="/" data-view="first">第一人称</a><a href="/third/" data-view="third">第三人称</a><a href="/dungeon/" data-view="dungeon">地下城 2.5D</a></nav>
<div class="viewer-hud"><div class="viewer-help"></div><div class="viewer-motion"></div><div class="viewer-held"></div><div class="viewer-hotbar"></div></div>
<div class="corti-crosshair" aria-hidden="true"></div>
<div class="corti-status-vignette" id="corti-status-vignette" aria-hidden="true"></div>
<div class="corti-survival" id="corti-survival" aria-label="Minecraft 生存状态">
  <div class="corti-armor" data-corti-armor></div>
  <div class="corti-vitals"><div data-corti-hearts></div><div data-corti-food></div></div>
  <div class="corti-air" data-corti-air></div>
  <div class="corti-level" data-corti-level></div>
  <div class="corti-xp"><div class="corti-xp-fill" data-corti-xp></div></div>
  <div class="corti-hotbar"><div class="corti-offhand corti-slot" data-corti-offhand title="副手"></div><div class="corti-hotbar-selection" data-corti-selection></div><div class="corti-hotbar-slots" data-corti-slots></div></div>
</div>
<div class="camera-follow-status" id="camera-follow-status" hidden><span>镜头跟随 <strong id="camera-follow-name"></strong></span><button type="button" id="camera-follow-return">返回</button></div>
<div class="ground-click-ping" id="ground-click-ping" hidden></div>
<section class="corti-cast" id="corti-cast" aria-label="施法提示" aria-live="polite" hidden><div class="corti-cast-sigil" aria-hidden="true">✦</div><div class="corti-cast-copy"><small data-cast-phase></small><strong data-cast-name></strong><span data-cast-detail></span></div><div class="corti-cast-line" aria-hidden="true"></div></section>
<div class="skill-cue" id="skill-cue" hidden><small data-skill-cue-source></small><strong data-skill-cue-title></strong><span data-skill-cue-evidence></span></div>
<div class="corti-event-feed" id="corti-event-feed" aria-label="游戏消息" aria-live="polite"></div>
<div class="corti-combat-floats" id="corti-combat-floats" aria-hidden="true"></div>
<div class="corti-presentation-toasts" id="corti-presentation-toasts" aria-live="polite"></div>
<aside class="corti-effects" id="corti-effects" aria-label="状态效果"></aside>
<aside class="corti-scoreboard" id="corti-scoreboard" aria-label="计分板" hidden></aside>
<div class="corti-boss-bars" id="corti-boss-bars" aria-label="Boss 血条"></div>
<div class="corti-game-title" id="corti-game-title" aria-live="assertive" hidden><strong data-game-title></strong><span data-game-subtitle></span></div>
<div class="corti-actionbar" id="corti-actionbar" aria-live="polite" hidden></div>
<iframe class="corti-speech-bubble" id="corti-speech-bubble" title="主播语音气泡" aria-label="主播语音气泡" hidden></iframe>
<aside class="corti-minimap" id="corti-minimap" aria-label="附近地形"><canvas width="200" height="200"></canvas><div class="corti-map-caption" data-map-caption></div></aside>
<aside class="corti-skills" id="corti-skills" aria-label="技能状态"><header><strong>技能</strong><span data-mana></span></header><div class="corti-mana-bar"><span data-mana-fill></span></div><div data-skill-list></div><div data-ability-list></div><small data-skill-status></small></aside>
<button type="button" class="corti-sound-toggle" id="corti-sound-toggle" aria-label="切换游戏音效">音效 待激活</button>
<button type="button" class="corti-night-vision-toggle" id="corti-night-vision-toggle" aria-label="切换夜视模式">夜视 自动</button>
<button type="button" class="corti-inventory-toggle" id="corti-inventory-toggle" aria-label="打开背包">背包 <kbd>E</kbd></button>
<section class="corti-menu" id="corti-menu" aria-label="物品界面" hidden><header><strong data-menu-title></strong><span data-menu-source></span><button type="button" data-menu-close aria-label="关闭物品界面">×</button></header><div data-menu-body></div></section>
<div class="dungeon-hover-card" id="dungeon-hover-card" hidden><span id="dungeon-hover-icon"></span><strong id="dungeon-hover-title"></strong><small id="dungeon-hover-subtitle"></small><em id="dungeon-hover-action"></em></div>
<div class="entity-context-menu" id="entity-context-menu" hidden><header><strong data-context-title></strong><small data-context-subtitle></small></header><div data-context-summary></div><div data-context-actions></div></div>
<aside class="entity-detail-card" id="entity-detail-card" hidden><button type="button" data-detail-close>关闭</button><h2 id="entity-detail-title" data-detail-title></h2><p data-detail-subtitle></p><div data-detail-rows></div></aside>
<script type="module" src="/index.js"></script><script src="/speech-bubble.js" defer></script></body></html>`;

const CSS = `html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#080d12;color:#f3f5f6;font:14px/1.4 system-ui,sans-serif}
canvas{position:absolute;inset:0;width:100%;height:100%;display:block}.boot{position:fixed;inset:0;z-index:5;display:grid;place-items:center;text-align:center;background:#080d12;color:#e6eeee;pointer-events:none}.boot.is-compact{inset:auto 12px 12px auto;display:block;padding:6px 9px;border-radius:6px;background:#101923dd}.boot.is-error{pointer-events:auto;color:#ffbdad}.viewer-hud{display:none}.corti-crosshair{position:fixed;z-index:3;top:50%;left:50%;width:30px;height:30px;transform:translate(-50%,-50%);background:url('/textures/gui/sprites/hud/crosshair.png') center/30px 30px no-repeat;image-rendering:pixelated;pointer-events:none}.corti-survival{position:fixed;z-index:3;bottom:8px;left:50%;width:364px;transform:translateX(-50%);pointer-events:none;image-rendering:pixelated;filter:drop-shadow(0 2px 2px #0009)}.corti-armor,.corti-air{height:18px;display:flex;gap:0}.corti-armor:empty,.corti-air:empty{display:none}.corti-vitals{height:20px;display:flex;justify-content:space-between}.corti-vitals>div{display:flex;flex-direction:row}.corti-vitals>div:last-child{flex-direction:row-reverse}.corti-icon{width:16px;height:18px;flex:none;background-position:left top;background-repeat:no-repeat;background-size:18px 18px}.corti-xp{position:relative;width:364px;height:10px;margin:2px 0 5px;background:url('/textures/gui/sprites/hud/experience_bar_background.png') left top/364px 10px no-repeat}.corti-xp-fill{height:10px;background:url('/textures/gui/sprites/hud/experience_bar_progress.png') left top/364px 10px no-repeat}.corti-level{position:absolute;bottom:59px;left:50%;transform:translateX(-50%);font:bold 20px/20px monospace;color:#80ff20;text-shadow:2px 2px #163500,-2px 2px #163500,2px -2px #163500,-2px -2px #163500;white-space:nowrap}.corti-level:empty{display:none}.corti-hotbar{position:relative;width:364px;height:44px;background:url('/textures/gui/sprites/hud/hotbar.png') center/364px 44px no-repeat}.corti-hotbar-selection{position:absolute;top:-2px;left:4px;width:48px;height:46px;background:url('/textures/gui/sprites/hud/hotbar_selection.png') center/48px 46px no-repeat}.corti-hotbar-slots{position:absolute;top:5px;left:8px;display:flex}.corti-slot{position:relative;width:40px;height:36px}.corti-slot img{position:absolute;top:2px;left:4px;width:32px;height:32px;object-fit:contain;image-rendering:pixelated}.corti-slot-count{position:absolute;right:0;bottom:-2px;color:#fff;font:bold 17px/18px monospace;text-shadow:2px 2px #222,-1px -1px #222}.corti-slot[title]{cursor:default}body>[hidden]{display:none!important}`;

const HUD_CSS = `.corti-item-fallback{position:absolute;inset:5px 2px 2px;display:grid;place-items:center;color:#eee;font:bold 11px/1 sans-serif;text-shadow:1px 1px #111}`;

const DURABILITY_CSS = `.corti-durability{position:absolute;z-index:2;left:5px;bottom:0;width:30px;height:4px;box-sizing:border-box;border:1px solid #111;background:#111;pointer-events:none}.corti-durability>span{display:block;height:2px}.corti-menu-slot .corti-durability{left:4px;bottom:1px;width:28px}`;

const ENCHANT_CSS = `.corti-enchant-glint{position:absolute;top:2px;z-index:1;width:32px;height:32px;pointer-events:none;image-rendering:pixelated;mask-position:center;mask-size:contain;mask-repeat:no-repeat;background:linear-gradient(110deg,#8a63ca66 0%,#8a63ca66 34%,#e2c0ffb8 46%,#a9daffcc 52%,#8254bf70 62%,#8a63ca66 100%);background-size:230% 100%;mix-blend-mode:screen;animation:corti-enchant-shine 2.4s linear infinite}.corti-enchanted-outline{box-shadow:inset 0 0 6px #ad7cffb0}@keyframes corti-enchant-shine{from{background-position:100% 0}to{background-position:-120% 0}}@media(prefers-reduced-motion:reduce){.corti-enchant-glint{animation:none;background-position:50% 0}}`;

const PANELS_CSS = `.corti-minimap,.corti-skills,.corti-inventory-toggle,.corti-menu{position:fixed;z-index:8;box-sizing:border-box}.corti-minimap{top:14px;left:14px;width:220px;padding:9px;background:#11242cdb;border:1px solid #b0ccb5a8;border-radius:9px;box-shadow:0 4px 20px #0007;pointer-events:none}.corti-minimap canvas{position:static;width:200px;height:200px;image-rendering:pixelated;border:1px solid #9eb9ad7a;background:#334746}.corti-map-caption{margin-top:4px;text-align:center;color:#f1f4de;font:12px/1.3 monospace;text-shadow:1px 1px #000}.corti-skills{top:14px;right:14px;width:220px;max-height:min(280px,40vh);overflow:auto;padding:10px;background:#11242cdb;border:1px solid #b0ccb5a8;border-radius:9px;box-shadow:0 4px 20px #0007;pointer-events:none}.corti-skills header{display:flex;justify-content:space-between;gap:8px;font-weight:700}.corti-skills [data-mana]{color:#a8e1ff}.corti-skills [data-skill-list]{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin-top:7px}.corti-skill{font-size:12px}.corti-skill strong{font:700 12px/1.3 monospace;color:#e6f7d4}.corti-skill-bar{height:3px;margin-top:2px;background:#44545d}.corti-skill-bar span{display:block;height:100%;background:#9bd47d}.corti-skills [data-skill-status]{display:block;margin-top:7px;color:#aebfc1;font-size:11px}.corti-inventory-toggle{right:14px;bottom:14px;padding:6px 10px;background:#1a2f36dd;color:#f0f5ed;border:1px solid #aec3b4;border-radius:7px;font:13px system-ui;cursor:pointer}.corti-inventory-toggle kbd{font:11px monospace;opacity:.8}.corti-menu{top:50%;left:50%;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);transform:translate(-50%,-50%);overflow:auto;padding:8px;background:#14242cec;border:1px solid #b8c8bb;border-radius:8px;box-shadow:0 10px 45px #000b;pointer-events:auto}.corti-menu[hidden]{display:none}.corti-menu header{display:flex;align-items:center;gap:10px;min-height:25px;margin-bottom:5px;color:#f8f8ed}.corti-menu header strong{flex:1}.corti-menu header span{font:11px/1.2 sans-serif;color:#a9bfc1}.corti-menu header button{padding:0 5px;background:none;color:#fff;border:0;font:22px/1 sans-serif;cursor:pointer}.corti-menu-body{position:relative;image-rendering:pixelated}.corti-menu-vanilla{width:352px;height:332px;background-position:left top;background-size:512px 512px;background-repeat:no-repeat}.corti-menu-slot{position:absolute;width:36px;height:36px;box-sizing:border-box}.corti-menu-slot img{position:absolute;top:2px;left:2px;width:32px;height:32px;image-rendering:pixelated}.corti-menu-slot small{position:absolute;right:0;bottom:0;color:#fff;font:700 15px/1 monospace;text-shadow:1px 1px #111,-1px -1px #111}.corti-menu-slot .corti-item-fallback{inset:3px;font-size:11px}.corti-menu-progress{position:absolute;overflow:hidden;background-repeat:no-repeat;background-position:left top;image-rendering:pixelated}.corti-menu-progress span{display:block;height:100%;background-repeat:no-repeat;background-position:left top;background-size:100% 100%}.corti-menu-generic{min-width:352px;padding:8px 8px 14px;background:#c6c6c6;color:#333}.corti-menu-generic h3{margin:0 0 6px;font-size:12px}.corti-menu-grid{display:grid;grid-template-columns:repeat(9,36px);gap:0}.corti-menu-grid .corti-menu-slot{position:relative;background:#8b8b8b;box-shadow:inset 2px 2px #383838,inset -2px -2px #eee}.corti-menu-generic .corti-menu-section{margin-top:13px}.corti-menu-note{padding:9px;color:#293835;font-size:12px}@media(max-width:720px){.corti-minimap{width:150px;padding:5px}.corti-minimap canvas{width:138px;height:138px}.corti-skills{width:155px;padding:6px}.corti-skills [data-skill-list]{grid-template-columns:1fr}.corti-menu{zoom:.8}}`;

const ABILITY_CSS = `.corti-skills{max-height:min(600px,75vh);pointer-events:auto}.corti-skills [data-ability-list]{display:grid;gap:3px;margin-top:8px;padding-top:7px;border-top:1px solid #849e9866}.corti-ability{display:flex;justify-content:space-between;gap:6px;color:#e3e8d9;font:11px/1.3 sans-serif}.corti-ability small{color:#b9d5e2;font:11px/1.3 monospace;white-space:nowrap}.corti-night-vision-toggle,.corti-sound-toggle{position:fixed;z-index:8;left:14px;padding:6px 10px;background:#1a2f36dd;color:#f0f5ed;border:1px solid #aec3b4;border-radius:7px;font:13px system-ui;cursor:pointer}.corti-night-vision-toggle{bottom:14px}.corti-night-vision-toggle[data-active="true"],.corti-sound-toggle[data-active="true"]{border-color:#c6e7a9;color:#eaffd6;background:#2a493bdd}.corti-sound-toggle{bottom:55px}`;

const CAST_CSS = `.corti-cast{position:fixed;z-index:9;top:16%;left:50%;width:min(440px,calc(100vw - 28px));min-height:112px;box-sizing:border-box;transform:translateX(-50%);display:flex;align-items:center;gap:18px;padding:16px 22px;color:#f9f5ff;background:linear-gradient(125deg,#14132bf0,#30264aee 65%,#142a37ee);border:2px solid #d3b2ef;border-radius:15px;box-shadow:0 9px 35px #000d,inset 0 0 25px #b69afa26;pointer-events:none;overflow:hidden;animation:corti-cast-enter .32s ease-out}.corti-cast[hidden]{display:none}.corti-cast[data-phase="succeeded"]{border-color:#c8e7bb}.corti-cast[data-phase="failed"]{border-color:#edaaaf}.corti-cast-sigil{display:grid;place-items:center;flex:none;width:66px;height:66px;border:2px solid #d7b9f0;border-radius:50%;box-shadow:0 0 17px #bf8ff688,inset 0 0 15px #bf8ff644;color:#f4d9ff;font-size:29px;text-shadow:0 0 11px #cba6fa;animation:corti-cast-orbit 8s linear infinite}.corti-cast[data-phase="succeeded"] .corti-cast-sigil{border-color:#c4ebc5;box-shadow:0 0 23px #8fe9ad99}.corti-cast[data-phase="failed"] .corti-cast-sigil{border-color:#e5adb1;box-shadow:0 0 17px #f0879088}.corti-cast-copy{display:flex;flex-direction:column;min-width:0;gap:2px}.corti-cast-copy small{font:700 14px/1.3 system-ui;letter-spacing:.14em;color:#e8d2ff}.corti-cast-copy strong{font:800 32px/1.2 system-ui;letter-spacing:.1em;text-shadow:0 0 13px #c9a8e299}.corti-cast-copy span{font:13px/1.4 system-ui;color:#e6e1f0}.corti-cast-line{position:absolute;bottom:0;left:0;width:100%;height:4px;background:linear-gradient(90deg,#b998ed,#f5d4ff,#a5d8ed);transform-origin:left;animation:corti-cast-line 5s linear both}.corti-cast[data-phase="succeeded"] .corti-cast-line{background:#b9ecc0;animation-duration:4s}.corti-cast[data-phase="failed"] .corti-cast-line{background:#e7afb4;animation-duration:4s}@keyframes corti-cast-enter{from{opacity:0;transform:translate(-50%,-12px) scale(.96)}to{opacity:1;transform:translate(-50%,0) scale(1)}}@keyframes corti-cast-orbit{to{transform:rotate(360deg)}}@keyframes corti-cast-line{from{transform:scaleX(1)}to{transform:scaleX(0)}}@media(max-width:720px){.corti-cast{top:12%;width:min(310px,calc(100vw - 20px));min-height:82px;padding:10px 14px;gap:11px}.corti-cast-sigil{width:48px;height:48px;font-size:22px}.corti-cast-copy strong{font-size:24px}}@media(prefers-reduced-motion:reduce){.corti-cast,.corti-cast-sigil,.corti-cast-line{animation:none}}`;

const NOTICE_CSS = `.corti-event-feed{position:fixed;z-index:7;left:14px;bottom:56px;width:min(385px,40vw);display:flex;flex-direction:column;align-items:flex-start;gap:5px;pointer-events:none}.corti-event{max-width:100%;box-sizing:border-box;padding:6px 10px;border-left:3px solid #a5d4e0;border-radius:4px;background:#10242bdc;box-shadow:0 2px 10px #0008;color:#f4f6f3;font:13px/1.45 system-ui;overflow-wrap:anywhere;text-shadow:1px 1px #000b}.corti-event small{margin-right:7px;color:#a9dce7;font-weight:700}.corti-event[data-kind="whisper"]{border-color:#b9a1e8}.corti-event[data-kind="whisper"] small{color:#dcc8ff}.corti-event[data-kind="advancement"]{border-color:#eacb79}.corti-event[data-kind="advancement"] small{color:#f9dfa0}.corti-event[data-kind="death"]{border-color:#e59191}.corti-game-title{position:fixed;z-index:8;top:33%;left:50%;width:min(700px,90vw);transform:translateX(-50%);text-align:center;color:#fff5e9;font:800 clamp(28px,5vw,53px)/1.25 system-ui;text-shadow:0 3px 12px #000,0 0 22px #b8a2ed;pointer-events:none;animation:corti-title-in var(--corti-title-fade-in,.28s) ease-out}.corti-game-title[hidden]{display:none}.corti-game-title[data-kind="death"]{color:#f4a9a9;text-shadow:0 3px 12px #000,0 0 24px #eb6464}body.corti-took-damage:after{content:"";position:fixed;inset:0;z-index:6;pointer-events:none;background:radial-gradient(ellipse at center,transparent 35%,#a92121a0 100%);animation:corti-damage .65s ease-out both}@keyframes corti-title-in{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}@keyframes corti-damage{from{opacity:.8}to{opacity:0}}@media(max-width:720px){.corti-event-feed{width:min(260px,60vw);bottom:54px}.corti-event{font-size:11px;padding:4px 7px}}@media(prefers-reduced-motion:reduce){.corti-game-title,body.corti-took-damage:after{animation:none}}`;

const EXTRA_FEEDBACK_CSS = `.corti-boss-bars{position:fixed;z-index:7;top:12px;left:50%;transform:translateX(-50%);width:min(360px,36vw);min-width:200px;display:grid;gap:5px;pointer-events:none}.corti-boss-bar{padding:2px 5px 4px;border:1px solid #30243fbd;border-radius:5px;background:#100f22bd;box-shadow:0 2px 8px #0008}.corti-boss-title{display:block;margin-bottom:2px;color:#fff7fa;text-align:center;font:700 12px/1.2 system-ui;text-shadow:1px 1px #000}.corti-boss-track{height:10px;border:1px solid #15101e;border-radius:2px;background:#271e2d;overflow:hidden}.corti-boss-fill{height:100%;background:linear-gradient(#cf8adf,#8d4aa0)}.corti-boss-bar[data-color="pink"] .corti-boss-fill{background:linear-gradient(#f5a5ce,#d76da8)}.corti-boss-bar[data-color="blue"] .corti-boss-fill{background:linear-gradient(#89b7ef,#4e81cb)}.corti-boss-bar[data-color="red"] .corti-boss-fill{background:linear-gradient(#e99496,#b44750)}.corti-boss-bar[data-color="green"] .corti-boss-fill{background:linear-gradient(#a5d893,#5fa45c)}.corti-boss-bar[data-color="yellow"] .corti-boss-fill{background:linear-gradient(#f5df8c,#d6ae47)}.corti-boss-bar[data-color="white"] .corti-boss-fill{background:linear-gradient(#f7f7f5,#bfc8cf)}.corti-game-title strong{display:block;font:inherit}.corti-game-title span{display:block;margin-top:8px;font:600 clamp(16px,2vw,23px)/1.3 system-ui}.corti-actionbar{position:fixed;z-index:7;left:50%;bottom:106px;max-width:min(680px,90vw);transform:translateX(-50%);padding:5px 12px;border-radius:5px;background:#101923ca;color:#fff7dc;text-align:center;font:700 17px/1.3 system-ui;text-shadow:1px 1px #000;pointer-events:none}.corti-actionbar[hidden]{display:none}@media(max-width:720px){.corti-boss-bars{top:8px;min-width:150px}.corti-boss-title{font-size:10px}.corti-actionbar{bottom:101px;font-size:13px}}`;
const ENCHANT_GLOW_CSS = `
.corti-enchanted img{filter:drop-shadow(0 0 2px #b17bff) drop-shadow(0 0 5px #a263e099)}
.corti-enchant-glint{opacity:.85;background-image:url('/textures/1.20.6/misc/enchanted_glint_item.png'),linear-gradient(110deg,#7442bd88 15%,#e4c7ffdd 48%,#8e56d4a8 72%);background-size:64px 64px,230% 100%;background-blend-mode:screen;animation:corti-enchant-pattern 2.8s linear infinite}
@keyframes corti-enchant-pattern{from{background-position:0 0,100% 0}to{background-position:128px -128px,-120% 0}}
@media(prefers-reduced-motion:reduce){.corti-enchant-glint{animation:none}}
`;
const VIEWER_LAYOUT_CSS = `
.corti-view-switch{position:fixed;z-index:9;top:14px;right:14px;display:flex;gap:2px;padding:3px;border:1px solid #b0ccb5a8;border-radius:8px;background:#11242cde;box-shadow:0 4px 20px #0007;opacity:.72;transition:opacity .2s ease}.corti-view-switch:hover,.corti-view-switch:focus-within{opacity:1}.corti-view-switch a{padding:4px 7px;border-radius:5px;color:#dce8e5;font:12px/1.2 system-ui;text-decoration:none;white-space:nowrap}.corti-view-switch a:hover,.corti-view-switch a:focus-visible{background:#ffffff25;outline:none}body[data-view-mode="first"] .corti-view-switch a[data-view="first"],body[data-view-mode="third"] .corti-view-switch a[data-view="third"],body[data-view-mode="dungeon"] .corti-view-switch a[data-view="dungeon"]{background:#8acbb34d;color:#f5fff6;font-weight:700}body[data-view-mode="third"] .corti-crosshair,body[data-view-mode="dungeon"] .corti-crosshair{display:none}.corti-skills{top:56px}
.boot.is-compact:not(.is-error){display:none}
.corti-event-feed{bottom:112px;max-height:min(26vh,170px);overflow:hidden;justify-content:flex-end}
.corti-event{flex:none;max-height:4.4em;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3}
.corti-boss-bars{max-height:min(18vh,110px);overflow:hidden}
.corti-game-title{top:35%;max-height:31vh;overflow:hidden;overflow-wrap:anywhere}
.corti-game-title strong,.corti-game-title span{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.corti-cast:not([hidden]) ~ .corti-game-title,.skill-cue:not([hidden]) ~ .corti-game-title{top:calc(16% + 130px)}
.skill-cue{position:fixed;z-index:8;top:21%;left:50%;width:min(360px,calc(100vw - 32px));box-sizing:border-box;transform:translateX(-50%);display:grid;gap:3px;padding:10px 16px;text-align:center;color:#f8eeff;background:#1b1535ed;border:1px solid #c2a0f1;border-radius:10px;box-shadow:0 8px 28px #000b,0 0 18px #a273df66;pointer-events:none}
.skill-cue[hidden],.corti-cast:not([hidden]) + .skill-cue{display:none}
.skill-cue small{color:#d7bbf5;font:700 12px/1.2 system-ui;letter-spacing:.08em}
.skill-cue strong{font:800 22px/1.2 system-ui;overflow-wrap:anywhere}
.skill-cue span{font:12px/1.35 system-ui;overflow-wrap:anywhere}
.corti-actionbar{bottom:112px;box-sizing:border-box;max-width:min(640px,calc(100vw - 32px));max-height:4.4em;overflow:hidden;overflow-wrap:anywhere}
@media(max-width:720px){.corti-event-feed{width:min(260px,42vw);bottom:120px}.corti-game-title{top:34%;font-size:clamp(25px,6vw,40px)}.corti-cast:not([hidden]) ~ .corti-game-title,.skill-cue:not([hidden]) ~ .corti-game-title{top:calc(12% + 95px)}.corti-actionbar{bottom:108px;width:max-content;max-width:calc(100vw - 24px)}.skill-cue{top:20%}}
@media(max-width:800px){.corti-view-switch{top:58px;right:8px}.corti-skills{top:100px}}
@media(max-height:560px){.corti-event-feed{max-height:22vh}.corti-cast{top:10%;min-height:82px;padding:10px 16px}.corti-cast:not([hidden]) ~ .corti-game-title,.skill-cue:not([hidden]) ~ .corti-game-title{top:calc(10% + 100px)}.corti-game-title{font-size:clamp(26px,4vw,42px)}.corti-game-title span{font-size:16px}.corti-actionbar{font-size:14px}}
`;
const SPEECH_BUBBLE_CSS = `.corti-speech-bubble{position:fixed;z-index:7;left:50%;bottom:150px;width:min(720px,72vw);height:178px;transform:translateX(-50%);border:0;background:transparent;pointer-events:none}@media(max-width:720px){.corti-speech-bubble{bottom:140px;width:calc(100vw - 20px);height:152px}}`;
const MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
  '.vrm': 'model/gltf-binary', '.webp': 'image/webp', '.jpg': 'image/jpeg',
};

async function serveAsset(res: ServerResponse, root: string, relative: string, cacheControl = 'public, max-age=3600'): Promise<boolean> {
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep) || !MIME[path.extname(file).toLowerCase()]) return false;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_ASSET_BYTES) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()], 'content-length': info.size,
    'cache-control': cacheControl, 'x-content-type-options': 'nosniff' });
  createReadStream(file).pipe(res);
  return true;
}

async function requiredAssetsPresent(root: string, version: string): Promise<boolean> {
  const source = JSON.parse(await readFile(path.join(root, 'public', 'asset-source.json'), 'utf8')) as { minecraftVersion?: string; clientJarSha256?: string };
  const client = JSON.parse(await readFile(path.join(root, 'viewer-client.json'), 'utf8')) as { minecraftVersion?: string; clientJarSha256?: string; browserBundleSha256?: string; mesherSha256?: string };
  if (source.minecraftVersion !== version || client.minecraftVersion !== version ||
      !source.clientJarSha256 || client.clientJarSha256 !== source.clientJarSha256) return false;
  for (const relative of ['dist/modern-viewer.js', 'public/mesher.js', 'public/mesherWasm.js',
    'public/threeWorker.js', `public/blocksStates/${version}.json`, `public/textures/${version}.png`,
    'render-assets/blockStatesModels.json', 'render-assets/blocksAtlases.json',
    'render-assets/itemsAtlases.json', 'render-assets/painting-records.json']) {
    if (!(await stat(path.join(root, relative)).catch(() => null))?.isFile()) return false;
  }
  const browserHash = createHash('sha256').update(await readFile(path.join(root, 'dist', 'modern-viewer.js'))).digest('hex');
  if (browserHash !== client.browserBundleSha256) return false;
  if (client.mesherSha256 && createHash('sha256').update(await readFile(path.join(root, 'public', 'mesher.js'))).digest('hex') !== client.mesherSha256) return false;
  return true;
}

export function ownEntity(bot: mineflayer.Bot): Record<string, unknown> {
  const entity = bot.entity;
  const inventory = bot.inventory as unknown as { slots?: unknown[]; hotbarStart?: number };
  const slots = inventory?.slots ?? [];
  const selected = Math.max(0, Math.min(8, Number(bot.quickBarSlot) || 0));
  const hotbarStart = Number.isInteger(inventory?.hotbarStart) ? inventory.hotbarStart! : 36;
  const equipped = (entity as unknown as { equipment?: unknown[] }).equipment ?? [];
  const equipment = [slots[hotbarStart + selected], slots[45],
    equipped[2], equipped[3], equipped[4], equipped[5]].map(viewerItem);
  return { id: entity.id, name: 'player', type: 'player', pos: entity.position,
    width: entity.width, height: entity.height, yaw: entity.yaw, pitch: entity.pitch,
    username: bot.username, isSelf: true, equipment };
}

const VILLAGER_TYPES = ['desert', 'jungle', 'plains', 'savanna', 'snow', 'swamp', 'taiga'];
const VILLAGER_PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith'];
const VILLAGER_LEVELS = ['none', 'stone', 'iron', 'gold', 'emerald', 'diamond'];

function villagerAppearance(value: unknown): Record<string, unknown> | null {
  const visited = new WeakSet<object>();
  const find = (entry: unknown, depth: number): Record<string, unknown> | null => {
    if (!entry || typeof entry !== 'object' || depth > 5 || ArrayBuffer.isView(entry) || visited.has(entry)) return null;
    visited.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry.slice(0, 64)) { const found = find(child, depth + 1); if (found) return found; }
      return null;
    }
    const data = entry as Record<string, unknown>;
    const keys = Object.fromEntries(Object.entries(data).map(([key, item]) => [key.replaceAll('_', '').toLowerCase(), item]));
    if ('villagertype' in keys && 'villagerprofession' in keys && 'level' in keys) return keys;
    for (const child of Object.values(data).slice(0, 48)) { const found = find(child, depth + 1); if (found) return found; }
    return null;
  };
  const data = find(value, 0);
  if (!data) return null;
  const bounded = (item: unknown, min: number, max: number, fallback: number) => {
    const n = Number(item);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const typeId = bounded(data.villagertype, 0, 6, 2);
  const professionId = bounded(data.villagerprofession, 0, 14, 0);
  const levelId = bounded(data.level, 1, 5, 1);
  return { typeId, typeKey: VILLAGER_TYPES[typeId], professionId,
    professionKey: VILLAGER_PROFESSIONS[professionId], levelId, levelKey: VILLAGER_LEVELS[levelId] };
}

function viewerEntity(bot: mineflayer.Bot, entity: ViewerEntity): Record<string, unknown> {
  const record = entity as unknown as Record<string, unknown>;
  const registry = bot.registry?.entitiesByName as Record<string,
    { name?: string; width?: number; height?: number; metadataKeys?: string[] }> | undefined;
  const appearance = villagerAppearance(record.metadata);
  const rawName = typeof record.name === 'string' ? record.name.replace(/^minecraft:/, '').toLowerCase() : '';
  const name = rawName && rawName !== 'unknown' ? rawName : appearance ? 'villager' :
    typeof record.type === 'string' && record.type !== 'mob' ? record.type.toLowerCase() : 'unknown';
  const dimensions = registry?.[name];
  return { id: entity.id, name, type: record.type, pos: entity.position, position: entity.position,
    width: entity.width || dimensions?.width || 0.6, height: entity.height || dimensions?.height || 1.8,
    yaw: entity.yaw, pitch: entity.pitch, headYaw: record.headYaw,
    velocity: entity.velocity ? { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z } : undefined,
    username: entity.username, uuid: entity.uuid, age: record.age,
    metadata: viewerRenderableMetadata(record.metadata),
    equipment: Array.isArray(record.equipment) ? record.equipment.slice(0, 6).map(viewerItem) : undefined,
    ...(name === 'villager' && appearance ? { villagerAppearance: appearance } : {}),
    ...(name === 'sheep' ? { sheepAppearance: viewerSheepAppearance(record.metadata,
      registry?.sheep?.metadataKeys) } : {}) };
}

function chunkWorldConfig(bot: mineflayer.Bot, x: number, z: number): { minY: number; worldHeight: number } {
  const world = bot.world as typeof bot.world & { getColumn?: (x: number, z: number) => unknown };
  let column: { minY?: number; worldHeight?: number } | undefined;
  try { column = world.getColumn?.(x / 16, z / 16) as typeof column; } catch { /* use dimension bounds */ }
  const game = bot.game as { minY?: number; height?: number; dimension?: string };
  const overworld = !game?.dimension || game.dimension === 'minecraft:overworld' || game.dimension === 'overworld';
  const minY = Number.isInteger(column?.minY) ? column!.minY! :
    Number.isInteger(game?.minY) ? game.minY! : overworld ? -64 : 0;
  const worldHeight = Number.isInteger(column?.worldHeight) && column!.worldHeight! > 0 ? column!.worldHeight! :
    Number.isInteger(game?.height) && game.height! > 0 ? game.height! : overworld ? 384 : 256;
  return { minY, worldHeight };
}

function diggingShape(block: { shapes?: number[][] }): { position: { x: number; y: number; z: number }; width: number; height: number; depth: number } {
  const shapes = Array.isArray(block.shapes) ? block.shapes.filter((shape) =>
    Array.isArray(shape) && shape.length === 6 && shape.every(Number.isFinite)) : [];
  if (!shapes.length) return { position: { x: 0.5, y: 0.5, z: 0.5 }, width: 1, height: 1, depth: 1 };
  const min = [0, 1, 2].map((axis) => Math.min(...shapes.map((shape) => shape[axis])));
  const max = [3, 4, 5].map((axis) => Math.max(...shapes.map((shape) => shape[axis])));
  return { position: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2,
    z: (min[2] + max[2]) / 2 }, width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] };
}

function entityAttribute(entity: Record<string, unknown>, suffix: string): number | null {
  const attrs = entity.attributes as Record<string, { value?: number; modifiers?: Array<{ amount?: number; operation?: number }> }> | undefined;
  const match = Object.entries(attrs ?? {}).find(([name]) => name === suffix || name.endsWith(`.${suffix}`));
  if (!match || !Number.isFinite(match[1].value)) return null;
  const base = match[1].value!;
  const modifiers = match[1].modifiers ?? [];
  let value = base;
  for (const modifier of modifiers) if (modifier.operation === 0) value += Number(modifier.amount) || 0;
  for (const modifier of modifiers) if (modifier.operation === 1) value += base * (Number(modifier.amount) || 0);
  for (const modifier of modifiers) if (modifier.operation === 2) value *= 1 + (Number(modifier.amount) || 0);
  return value;
}

function equipmentArmor(equipment: unknown[]): number {
  const points: Record<string, [number, number, number, number]> = {
    leather: [1, 2, 3, 1], golden: [1, 3, 5, 2], chainmail: [1, 4, 5, 2],
    iron: [2, 5, 6, 2], diamond: [3, 6, 8, 3], netherite: [3, 6, 8, 3],
  };
  return equipment.slice(2, 6).reduce<number>((total, item, slot) => {
    const name = (item as { name?: string } | null)?.name ?? '';
    if (name === 'turtle_helmet') return total + 2;
    const material = Object.keys(points).find((prefix) => name.startsWith(`${prefix}_`));
    return total + (material ? points[material][slot] : 0);
  }, 0);
}

function avatarState(bot: mineflayer.Bot, sequence: number, shieldRaised = false): Record<string, unknown> {
  const entity = bot.entity as unknown as Record<string, unknown>;
  const velocity = entity.velocity as { x?: number; y?: number; z?: number } | undefined;
  const speed = Math.hypot(Number(velocity?.x) || 0, Number(velocity?.z) || 0);
  const inventory = (bot.inventory ?? {}) as unknown as { slots?: unknown[]; hotbarStart?: number };
  const slots = inventory.slots ?? [];
  const start = Number.isInteger(inventory.hotbarStart) ? inventory.hotbarStart! : 36;
  const selected = Math.max(0, Math.min(8, Number(bot.quickBarSlot) || 0));
  const equipment = Array.isArray(entity.equipment) ? entity.equipment : [];
  const experience = bot.experience as { level?: number | null; progress?: number | null } | undefined;
  const rawHealth = Number(bot.health);
  const rawFood = Number(bot.food);
  const oxygen = Number((bot as mineflayer.Bot & { oxygenLevel?: number }).oxygenLevel);
  const sprinting = bot.controlState?.sprint === true;
  const sneaking = bot.controlState?.sneak === true;
  return {
    seq: sequence, sequence, capturedAt: Date.now(), entity: ownEntity(bot),
    movementState: viewerMovementState(speed, sprinting, sneaking),
    horizontalSpeed: speed,
    verticalSpeed: Number(velocity?.y) || 0,
    velocity: { x: Number(velocity?.x) || 0, y: Number(velocity?.y) || 0, z: Number(velocity?.z) || 0 },
    onGround: entity.onGround === true, inWater: entity.isInWater === true, shieldRaised,
    inLava: entity.isInLava === true, sprinting,
    sneaking, quickBarSlot: selected,
    health: Number.isFinite(rawHealth) ? rawHealth : null,
    maxHealth: Math.max(20, entityAttribute(entity, 'max_health') ?? 20, Number.isFinite(rawHealth) ? rawHealth : 0),
    food: Number.isFinite(rawFood) ? rawFood : null,
    armor: Math.max(0, Math.min(20, entityAttribute(entity, 'armor') ?? equipmentArmor(equipment))),
    oxygen: Number.isFinite(oxygen) ? Math.max(0, Math.min(20, oxygen)) : null,
    experienceLevel: Number.isFinite(experience?.level) ? experience!.level : null,
    experienceProgress: Number.isFinite(experience?.progress) ? experience!.progress : null,
    offhand: viewerItem(slots[45]),
    equipment: equipment.slice(0, 6).map(viewerItem),
    hotbar: Array.from({ length: 9 }, (_, index) => ({
      index, slot: start + index, selected: index === selected, item: viewerItem(slots[start + index]),
    })),
    inventory: slots.slice(0, 64).map(viewerItem),
  };
}

export async function startModernViewer(bot: mineflayer.Bot, options: ModernViewerOptions): Promise<ModernViewerHandle> {
  const root = path.resolve(options.assetsDir);
  if (!(await requiredAssetsPresent(root, bot.version))) throw new Error(`modern viewer: ${bot.version} 资源不完整 ${root}`);
  const speechBubbleScript = await readFile(new URL('./speech-bubble-client.js', import.meta.url), 'utf8');
  const speakerScript = speechBubbleScript.replace("'__VIEWER_SPEAKER_NAME__'",
    JSON.stringify(options.speakerName || bot.username));

  const origin = `http://127.0.0.1:${options.port}`;
  const sessions = new Set<() => void>();
  const viewerSockets = new Set<Socket>();
  let latestSkills: ViewerSkills | null = null;
  let agentManaSeen = false;
  let castSequence = 0;
  let pendingCasts: { seq: number; spell: ViewerCastCommand; sentAtMs: number }[] = [];
  const publishCast = (cue: Record<string, unknown>) => {
    for (const socket of viewerSockets) if (socket.connected) socket.emit('castCue', cue);
  };
  const onCastCommand = (text: string) => {
    const spell = viewerCastCommand(text);
    if (!spell) return;
    const cast = { seq: ++castSequence, spell, sentAtMs: Date.now() };
    pendingCasts = pendingCasts.filter((entry) => cast.sentAtMs - entry.sentAtMs <= 7_000).slice(-7);
    pendingCasts.push(cast);
    publishCast({ seq: cast.seq, phase: 'sent', spellId: spell.id, spellName: spell.name });
  };
  const onCastMessage = (message: { toString(): string }, position: string) => {
    if (position !== 'chat' && position !== 'system') return;
    const now = Date.now();
    pendingCasts = pendingCasts.filter((entry) => now - entry.sentAtMs <= 7_000);
    const text = message.toString();
    const candidates = pendingCasts.filter((entry) => text.includes(entry.spell.name) || text.includes(entry.spell.id));
    const match = [...candidates, ...pendingCasts.filter((entry) => !candidates.includes(entry))]
      .map((cast) => ({ cast, result: viewerCastResult(text, cast.spell.id) }))
      .find((entry) => entry.result);
    if (!match?.result) return;
    const { cast, result } = match;
    publishCast({ seq: cast.seq, spellId: cast.spell.id, spellName: cast.spell.name, ...result });
    pendingCasts = pendingCasts.filter((entry) => entry !== cast);
  };
  const publishGameMessage = (kind: string, value: unknown) => {
    const text = minecraftTextComponent(value).slice(0, 160);
    if (!text) return;
    for (const socket of viewerSockets) if (socket.connected) socket.emit('gameMessage', { kind, text });
  };
  let soundWindowAtMs = 0;
  let soundCount = 0;
  const onViewerSound = (soundName: string, position: { x: number; y: number; z: number } | null,
    volume: number, pitch: number) => {
    if (closed || !viewerSockets.size) return;
    const name = String(soundName).replace(/^minecraft:/, '');
    if (!/^[a-z0-9_.-]{1,100}$/.test(name)) return;
    const now = Date.now();
    if (now - soundWindowAtMs >= 1000) { soundWindowAtMs = now; soundCount = 0; }
    if (++soundCount > 48) return;
    const pos = position && [position.x, position.y, position.z].every(Number.isFinite)
      ? { x: position.x, y: position.y, z: position.z } : null;
    const event = { name, position: pos,
      volume: Number.isFinite(volume) ? Math.max(0, Math.min(4, volume)) : 1,
      pitch: Number.isFinite(pitch) ? Math.max(0.5, Math.min(2, pitch)) : 1 };
    for (const socket of viewerSockets) if (socket.connected) socket.emit('worldSound', event);
  };
  const recordManaText = (text: string) => {
    // A structured state snapshot wins over incidental spell feedback in chat.
    if (agentManaSeen || (latestSkills?.source === 'plugin' && latestSkills.mana !== null
      && Date.now() - (latestSkills.observedAt ?? 0) < 300_000)) return;
    const mana = manaSnapshotFromText(text);
    if (!mana) return;
    latestSkills = { ...(latestSkills ?? { schemaVersion: 1, skills: [], abilities: [] }),
      mana, source: latestSkills?.source ?? 'chat', observedAt: Date.now() };
    for (const socket of viewerSockets) if (socket.connected) socket.emit('skillsState', latestSkills);
  };
  const onViewerMessage = (message: { translate?: string; toString(): string }, position: string) => {
    const kind = viewerMessageKind(message, position);
    if (kind) publishGameMessage(kind, message);
    // AgentFriend reports an authoritative mana snapshot in ordinary system text
    // when a cast is refused. Keep it visible until the server publishes mcagent:state.
    if (position === 'chat' || position === 'system') recordManaText(message.toString());
  };
  const onViewerTitle = (value: unknown, type: 'subtitle' | 'title') =>
    publishGameMessage(type === 'subtitle' ? 'subtitle' : 'title', value);
  const onViewerTitleTimes = (fadeIn: number, stay: number, fadeOut: number) => {
    const ticks = [fadeIn, stay, fadeOut];
    if (!ticks.every((value) => Number.isInteger(value) && value >= 0 && value <= 1_200)) return;
    for (const socket of viewerSockets) if (socket.connected) socket.emit('gameTitleTiming', { fadeIn, stay, fadeOut });
  };
  const onViewerTitleClear = () => {
    for (const socket of viewerSockets) if (socket.connected) socket.emit('gameTitleClear');
  };
  const onViewerActionBar = (value: unknown) => {
    publishGameMessage('actionbar', value);
    recordManaText(minecraftTextComponent(value));
  };
  const onViewerDeath = () => {
    publishGameMessage('death', '角色阵亡');
    latestSkills = { ...(latestSkills ?? { schemaVersion: 1, skills: [], abilities: [] }),
      mana: null, observedAt: Date.now() };
    for (const socket of viewerSockets) if (socket.connected) socket.emit('skillsState', latestSkills);
  };
  let cachedMinimap: ReturnType<typeof minimapSnapshot> | null = null;
  let cachedMinimapAtMs = 0;
  const protocol = bot._client as unknown as {
    on(event: string, listener: (...args: any[]) => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    write(name: string, params?: Record<string, unknown>): void;
  };
  const advancements = new ViewerAdvancementTracker();
  const observedPackets = new Map<string, number>();
  const observedChannels = new Map<string, number>();
  const onPacketObserved = (_packet: unknown, meta: { name?: unknown }) => {
    if (typeof meta?.name !== 'string' || !/^[a-z_]{1,64}$/.test(meta.name)) return;
    observedPackets.set(meta.name, (observedPackets.get(meta.name) ?? 0) + 1);
  };
  const publishPresentation = (event: unknown) => {
    for (const socket of viewerSockets) if (socket.connected) socket.emit('presentationEvent', event);
  };
  let particleWindowAt = 0;
  let particleCount = 0;
  const onParticle = (packet: unknown) => {
    if (closed || !viewerSockets.size) return;
    const now = Date.now();
    if (now - particleWindowAt >= 1_000) { particleWindowAt = now; particleCount = 0; }
    if (++particleCount > 96) return;
    const event = viewerParticle(packet);
    if (event) publishPresentation(event);
  };
  const onExplosion = (packet: unknown) => {
    const event = viewerExplosion(packet);
    if (event) publishPresentation(event);
  };
  const onWorldEvent = (packet: unknown) => {
    const event = viewerWorldEvent(packet);
    if (event) publishPresentation(event);
  };
  const onCollect = (packet: { collectedEntityId?: number; collectorEntityId?: number; pickupItemCount?: number }) => {
    if (!Number.isInteger(packet.collectedEntityId) || !Number.isInteger(packet.collectorEntityId)) return;
    const from = Object.values(bot.entities).find(entity => entity.id === packet.collectedEntityId);
    const to = packet.collectorEntityId === bot.entity?.id ? bot.entity
      : Object.values(bot.entities).find(entity => entity.id === packet.collectorEntityId);
    if (!from?.position || !to?.position) return;
    publishPresentation({ kind: 'pickup', position: { x: from.position.x, y: from.position.y, z: from.position.z },
      to: { x: to.position.x, y: to.position.y + 1, z: to.position.z },
      count: Math.max(1, Math.min(64, packet.pickupItemCount || 1)) });
  };
  const effectDetails = (id: number) => {
    const registry = bot.registry as unknown as { effects?: Record<number, { name?: string; displayName?: string; type?: string }> };
    const effect = registry.effects?.[id];
    const name = String(effect?.name || `effect_${id}`).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    return { name: /^[a-z0-9_]+$/.test(name) ? name : `effect_${id}`,
      title: String(effect?.displayName || effect?.name || `效果 ${id}`).slice(0, 60),
      type: effect?.type === 'bad' ? 'bad' : 'good' };
  };
  const onEntityEffect = (packet: { entityId?: number; effectId?: number; amplifier?: number; duration?: number }) => {
    if (!Number.isInteger(packet.entityId) || !Number.isInteger(packet.effectId)) return;
    const self = packet.entityId === bot.entity?.id;
    const target = self ? bot.entity : Object.values(bot.entities).find(entity => entity.id === packet.entityId);
    if (!self && !target?.position) return;
    publishPresentation({ kind: 'effect', id: packet.effectId, self, active: true,
      ...effectDetails(packet.effectId!), amplifier: Math.max(0, Math.min(255, packet.amplifier || 0)),
      durationTicks: Math.max(0, Math.min(72_000, packet.duration || 0)),
      position: target?.position ? { x: target.position.x, y: target.position.y + 1,
        z: target.position.z } : undefined });
  };
  const onRemoveEntityEffect = (packet: { entityId?: number; effectId?: number }) => {
    if (packet.entityId === bot.entity?.id && Number.isInteger(packet.effectId))
      publishPresentation({ kind: 'effect', id: packet.effectId, active: false,
        ...effectDetails(packet.effectId!) });
  };
  const onCooldown = (packet: { itemID?: number; cooldownTicks?: number }) => {
    if (!Number.isInteger(packet.itemID) || !Number.isInteger(packet.cooldownTicks)) return;
    publishPresentation({ kind: 'cooldown', itemId: packet.itemID,
      durationTicks: Math.max(0, Math.min(1_200, packet.cooldownTicks!)) });
  };
  const onAdvancements = (packet: unknown) => {
    for (const notice of advancements.ingest(packet, minecraftTextComponent))
      publishPresentation({ kind: 'achievement', id: notice.key, title: notice.title,
        body: notice.description, tone: notice.frame === 'challenge' ? 'arcane' : 'positive' });
  };
  const onSkillPacket = (packet: { channel?: unknown; data?: unknown }) => {
    if (typeof packet.channel === 'string' && /^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(packet.channel))
      observedChannels.set(packet.channel, (observedChannels.get(packet.channel) ?? 0) + 1);
    const custom = parseViewerCustomEvent(packet.channel, packet.data);
    if (custom) { publishPresentation(custom); return; }
    const next = parseSkillsPayload(packet.channel, packet.data);
    if (next) {
      if (packet.channel === VIEWER_STATE_CHANNEL) agentManaSeen = true;
      latestSkills = { ...next,
        mana: packet.channel === VIEWER_STATE_CHANNEL || !agentManaSeen
          ? next.mana : latestSkills?.mana ?? null,
        skills: next.skills.length ? next.skills : latestSkills?.skills ?? [],
        abilities: next.abilities.length ? next.abilities : latestSkills?.abilities ?? [],
        source: 'plugin', observedAt: Date.now() };
      for (const socket of viewerSockets) if (socket.connected) socket.emit('skillsState', latestSkills);
      return;
    }
    const hit = bot.entity && parseViewerCombatHit(packet.channel, packet.data, bot.entity.id);
    if (hit) for (const socket of viewerSockets) if (socket.connected) socket.emit('combatFeedback', hit);
  };
  const currentMinimap = () => {
    if (!bot.entity) return null;
    const now = Date.now();
    const x = Math.floor(bot.entity.position.x);
    const z = Math.floor(bot.entity.position.z);
    if (!cachedMinimap || now - cachedMinimapAtMs > 3_000 ||
      Math.abs(cachedMinimap.centerX - x) > 2 || Math.abs(cachedMinimap.centerZ - z) > 2 ||
      cachedMinimap.dimension !== String(bot.game.dimension || 'minecraft:overworld')) {
      cachedMinimap = minimapSnapshot(bot as unknown as Parameters<typeof minimapSnapshot>[0]);
      cachedMinimapAtMs = now;
    }
    return cachedMinimap;
  };
  let closed = false;
  const headTextures = new Map<string, Buffer>();
  const server = createServer((req, res) => { void handleRequest(req, res); });
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const pathname = new URL(req.url ?? '/', origin).pathname;
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${options.port}`) { res.writeHead(403); res.end(); return; }
      if (pathname === '/' || pathname === '/third/' || pathname === '/dungeon/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'self' data: blob:; connect-src 'self' data: blob: ws://127.0.0.1:* http://127.0.0.1:*; frame-src 'self' http://127.0.0.1:*; img-src 'self' data: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'" });
        const viewMode = pathname === '/third/' ? 'third' : pathname === '/dungeon/' ? 'dungeon' : 'first';
        res.end(PAGE.replace('__VIEW_MODE__', viewMode)); return;
      }
      if (pathname === '/viewer.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' }); res.end(CSS + HUD_CSS + '.corti-offhand{position:absolute;left:-45px;top:4px;width:40px;height:36px;background:#505050bb;border:2px solid #a8a8a8;box-sizing:border-box;box-shadow:inset 2px 2px #272727,inset -2px -2px #ddd}' + DURABILITY_CSS + ENCHANT_CSS + ENCHANT_GLOW_CSS + PANELS_CSS + MANA_CSS + ABILITY_CSS + CAST_CSS + NOTICE_CSS + COMBAT_CSS + EXTRA_FEEDBACK_CSS + VIEWER_LAYOUT_CSS + SPEECH_BUBBLE_CSS + PRESENTATION_CSS + STATUS_VIGNETTE_CSS + THEME_SURFACE_CSS); return;
      }
      if (pathname === '/speech-bubble.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(speakerScript); return;
      }
      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: !closed, version: bot.version, viewers: sessions.size })); return;
      }
      if (pathname === '/viewer-coverage') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ version: bot.version,
          channels: [...observedChannels].map(([name, count]) => ({ name, count })),
          skills: latestSkills ? { source: latestSkills.source, observedAt: latestSkills.observedAt,
            hasMana: latestSkills.mana !== null, skillCount: latestSkills.skills.length } : null,
          packets: [...observedPackets].map(([name, count]) => ({ name, count,
            renderLane: viewerPacketLane(name) })).sort((a, b) => b.count - a.count) }));
        return;
      }
      const headHash = /^\/head-texture\/([0-9a-f]{40,64})\.png$/.exec(pathname)?.[1];
      if (headHash) {
        let texture = headTextures.get(headHash);
        if (!texture) {
          const source = await fetch(`https://textures.minecraft.net/texture/${headHash}`, {
            redirect: 'error', signal: AbortSignal.timeout(5_000),
          });
          if (!source.ok || !source.headers.get('content-type')?.startsWith('image/png') ||
              Number(source.headers.get('content-length') ?? 0) > 1_048_576) {
            res.writeHead(502); res.end(); return;
          }
          texture = Buffer.from(await source.arrayBuffer());
          if (texture.length > 1_048_576 || !texture.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
            res.writeHead(502); res.end(); return;
          }
          if (headTextures.size >= 128) headTextures.delete(headTextures.keys().next().value!);
          headTextures.set(headHash, texture);
        }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': texture.length,
          'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
        res.end(texture); return;
      }
      const relative = pathname.replace(/^\/(third|dungeon)\//, '/').slice(1);
      if (relative === 'index.js' && await serveAsset(res, root, 'dist/modern-viewer.js', 'no-store')) return;
      if (await serveAsset(res, path.join(root, 'public'), relative)) return;
      if (relative.startsWith('textures/') && await serveAsset(res, path.join(root, 'public'),
        `textures/${bot.version}/${relative.slice('textures/'.length)}`)) return;
      res.writeHead(404); res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  const allowRequest = (req: IncomingMessage, done: (error: string | null, success: boolean) => void) => {
    const allowed = req.headers.host === `127.0.0.1:${options.port}`
      && (req.headers.origin === undefined || req.headers.origin === origin);
    done(allowed ? null : 'forbidden', allowed);
  };
  const first = new SocketServer(server, { path: '/socket.io', serveClient: false, allowRequest });
  const third = new SocketServer(server, { path: '/third/socket.io', serveClient: false, allowRequest });
  let shieldRaised = false;

  function accept(socket: Socket, view: 'first' | 'third'): void {
    if (closed || !bot.entity || sessions.size >= MAX_SESSIONS) {
      socket.emit('viewerBusy', { maximum: MAX_SESSIONS }); socket.disconnect(true); return;
    }
    // WorldView owns chunks and block updates. Its stock entity packets omit villager
    // metadata, so the bounded stream below publishes entities separately.
    const biomeIds = biomeIdMap(bot.registry, vanillaBiomes);
    const chunkEntities = new Map<string, Record<string, unknown>>();
    let lastBlockEntities = '';
    const publishBlockEntities = () => {
      const snapshot = viewerBlockEntities(chunkEntities.values());
      const signature = JSON.stringify(snapshot);
      if (signature === lastBlockEntities) return false;
      lastBlockEntities = signature;
      socket.emit('blockEntities', snapshot);
      return true;
    };
    const refreshChunkEntities = (x: number, z: number) => {
      const origin = { x: Math.floor(x / 16) * 16, z: Math.floor(z / 16) * 16 };
      const key = `${origin.x},${origin.z}`;
      if (!chunkEntities.has(key)) return false;
      const column = bot.world.getColumn(origin.x / 16, origin.z / 16) as unknown as {
        blockEntities?: Record<string, unknown>;
      } | null;
      chunkEntities.set(key, viewerChunkBlockEntities(origin, column?.blockEntities));
      return publishBlockEntities();
    };
    const worldSocket = { on: socket.on.bind(socket), emit: (event: string, payload: unknown) => {
      if (event === 'loadChunk') {
        const chunk = payload as { x: number; z: number; chunk: string };
        chunkEntities.set(`${chunk.x},${chunk.z}`, {});
        refreshChunkEntities(chunk.x, chunk.z);
        socket.emit(event, { ...chunk,
          chunk: remapViewerChunkBiomes(chunk.chunk, biomeIds, plainsBiomeId),
          worldConfig: chunkWorldConfig(bot, chunk.x, chunk.z) });
      } else if (event === 'unloadChunk') {
        const chunk = payload as { x: number; z: number };
        chunkEntities.delete(`${chunk.x},${chunk.z}`);
        publishBlockEntities();
        socket.emit(event, payload);
      } else if (event === 'blockUpdate') {
        const update = payload as { pos: { x: number; z: number } };
        refreshChunkEntities(update.pos.x, update.pos.z);
        socket.emit(event, payload);
      } else if (event !== 'entity') socket.emit(event, payload);
      return true;
    } } as unknown as Socket;
    const worldView = new WorldView(bot.world, VIEW_DISTANCE, bot.entity.position, worldSocket);
    socket.removeAllListeners('mouseClick');
    let active = true;
    let initialized = false;
    let resetting = false;
    let sequence = 0;
    let digKey = '';
    let digStartedAt = 0;
    let digDuration = 1000;
    let digStage = -1;
    let trackedWindowId: number | null = null;
    let containerSignature = '';
    const windowProperties = new Map<number, number>();
    const onWindowProperty = (packet: { windowId?: number; property?: number; value?: number }) => {
      if (packet.windowId !== bot.currentWindow?.id || !Number.isInteger(packet.property) ||
          !Number.isFinite(packet.value)) return;
      if (trackedWindowId !== packet.windowId) {
        trackedWindowId = packet.windowId!;
        windowProperties.clear();
      }
      windowProperties.set(packet.property!, packet.value!);
    };
    protocol.on('craft_progress_bar', onWindowProperty);
    const onBlockEntityData = (packet: { location?: { x: number; y: number; z: number } }) => {
      if (!active || !packet.location) return;
      const position = packet.location;
      if (!refreshChunkEntities(position.x, position.z)) return;
      const stateId = bot.blockAt(new Vec3(position.x, position.y, position.z))?.stateId;
      if (stateId !== undefined) socket.emit('blockUpdate', { pos: position, stateId });
    };
    protocol.on('tile_entity_data', onBlockEntityData);
    const publishContainer = () => {
      if (!active || !socket.connected) return;
      const window = bot.currentWindow;
      if (window?.id !== trackedWindowId) {
        trackedWindowId = window?.id ?? null;
        windowProperties.clear();
      }
      const state = windowSnapshot(window as Parameters<typeof windowSnapshot>[0], windowProperties, viewerItem);
      const signature = JSON.stringify(state);
      if (signature === containerSignature) return;
      containerSignature = signature;
      socket.emit('containerState', state);
    };
    const containerTimer = setInterval(publishContainer, 150);
    let scoreboardSignature = '';
    const publishScoreboard = () => {
      if (!active || !socket.connected) return;
      const board = bot.scoreboard?.sidebar;
      const rows = (board?.items ?? []).filter(item => item && !item.name.startsWith('#'))
        .slice(0, 15).map(item => ({ name: minecraftTextComponent(item.displayName).slice(0, 80),
          value: Number.isFinite(item.value) ? item.value : 0 }));
      const state = { title: board ? minecraftTextComponent(board.title).slice(0, 80) : '', rows };
      const signature = JSON.stringify(state);
      if (signature === scoreboardSignature) return;
      scoreboardSignature = signature;
      socket.emit('scoreboardState', state);
    };
    const scoreboardTimer = setInterval(publishScoreboard, 500);
    const publishMinimap = () => {
      if (!active || !socket.connected) return;
      const snapshot = currentMinimap();
      if (snapshot) socket.emit('minimap', snapshot);
    };
    const minimapTimer = setInterval(publishMinimap, 2_000);
    let lastLight = '';
    const publishLight = () => {
      if (!active || !socket.connected) return;
      const state = viewerLight(bot);
      const signature = JSON.stringify(state);
      if (signature === lastLight) return;
      lastLight = signature;
      socket.emit('lightingState', state);
    };
    const lightTimer = setInterval(publishLight, 500);
    const pendingEntities = new Map<string, { entity: ViewerEntity; full: boolean }>();
    const knownEntities = new Set<string>();
    const nearby = (entity: ViewerEntity) => entity !== bot.entity && entity.position && bot.entity?.position &&
      Math.hypot(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z) <= VIEW_DISTANCE * 16;
    const removeEntity = (entity: ViewerEntity) => {
      const id = String(entity.id);
      pendingEntities.delete(id);
      if (knownEntities.delete(id) && socket.connected) socket.emit('entity', { id: entity.id, delete: true });
    };
    const queueEntity = (entity: ViewerEntity, full = false) => {
      if (!active || !entity || entity.id === undefined) return;
      if (!nearby(entity)) { removeEntity(entity); return; }
      const id = String(entity.id);
      if (pendingEntities.size < 256 || pendingEntities.has(id)) pendingEntities.set(id, {
        entity, full: full || pendingEntities.get(id)?.full === true,
      });
    };
    const entitySpawn = (entity: ViewerEntity) => queueEntity(entity, true);
    const entityMoved = (entity: ViewerEntity) => queueEntity(entity);
    const entityUpdate = (entity: ViewerEntity) => queueEntity(entity, true);
    const flushEntities = () => {
      if (!active || !socket.connected || socket.conn?.transport?.writable === false) return;
      for (const id of knownEntities) {
        const entity = bot.entities[id];
        if (!entity || !nearby(entity)) removeEntity(entity ?? { id: Number(id) } as ViewerEntity);
      }
      const rows = [...pendingEntities.values()];
      pendingEntities.clear();
      for (const { entity, full } of rows) {
        if (!nearby(entity)) { removeEntity(entity); continue; }
        const id = String(entity.id);
        if (!knownEntities.has(id) && knownEntities.size >= 128) continue;
        const complete = full || !knownEntities.has(id);
        socket.emit(complete ? 'entity' : 'entityMoved', complete ? viewerEntity(bot, entity) :
          { id: entity.id, pos: entity.position, yaw: entity.yaw, pitch: entity.pitch,
            headYaw: (entity as unknown as { headYaw?: number }).headYaw });
        knownEntities.add(id);
      }
    };
    const entityTimer = setInterval(flushEntities, 100);
    const publishDigging = () => {
      const block = bot.targetDigBlock;
      const pos = block?.position;
      const next = pos && [pos.x, pos.y, pos.z].every(Number.isInteger) ? `${pos.x},${pos.y},${pos.z}` : '';
      if (!next) {
        if (digKey) socket.emit('digProgress', { stage: null });
        digKey = ''; digStage = -1;
        return;
      }
      if (next !== digKey) {
        digKey = next; digStartedAt = Date.now(); digStage = -1;
        try { digDuration = Math.max(50, Math.min(30000, Number(bot.digTime(block)) || 1000)); }
        catch { digDuration = 1000; }
      }
      const stage = Math.max(0, Math.min(9, Math.floor((Date.now() - digStartedAt) / digDuration * 10)));
      if (stage !== digStage) {
        digStage = stage;
        socket.emit('digProgress', { x: pos!.x, y: pos!.y, z: pos!.z,
          stage, mergedShape: diggingShape(block!) });
      }
    };
    const publishAvatar = () => {
      if (active && bot.entity && socket.connected) {
        socket.emit('avatarState', avatarState(bot, ++sequence, shieldRaised));
        publishDigging();
      }
    };
    const avatarTimer = setInterval(publishAvatar, 100);
    const position = (_position?: unknown, teleport = false) => {
      if (!active || !bot.entity) return;
      socket.emit('position', { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: bot.entity.pitch,
        addMesh: view === 'third', teleport: teleport === true });
      socket.emit(view === 'third' ? 'entityMoved' : 'playerEntity', ownEntity(bot));
      if (initialized) void worldView.updatePosition(bot.entity.position).catch(() => socket.disconnect(true));
    };
    const forcedPosition = () => position(undefined, true);
    const time = () => { socket.emit('time', bot.time.timeOfDay); };
    const weather = () => {
      const raining = isRaining(bot);
      socket.emit('weather', { raining, thunder: raining ? bot.thunderState : 0 });
    };
    const publishBossBars = () => {
      if (active && socket.connected) socket.emit('bossBars', viewerBossBars((bot as typeof bot & { bossBars?: unknown }).bossBars));
    };
    const stopBossBars = observeViewerBossBars(bot, publishBossBars);
    let lastBiome = '';
    const biome = () => {
      if (!active || !bot.entity || !socket.connected) return;
      const position = bot.entity.position.floored();
      let name = '';
      let id: number | undefined;
      try {
        const blockBiome = bot.blockAt(position)?.biome as { name?: string; id?: number } | undefined;
        name = blockBiome?.name || '';
        id = blockBiome?.id;
        if (!name) {
          const chunkX = Math.floor(position.x / 16), chunkZ = Math.floor(position.z / 16);
          const column = bot.world.getColumn(chunkX, chunkZ) as unknown as {
            getBiome?: (point: unknown) => number | { id?: number; name?: string };
          } | null;
          const value = column?.getBiome?.(position.offset(-chunkX * 16, 0, -chunkZ * 16));
          if (typeof value === 'number') id ??= value;
          else if (value) { id ??= value.id; name ||= value.name || ''; }
        }
      } catch { /* chunk may still be arriving */ }
      const biomes = bot.registry as typeof bot.registry & {
        biomes?: Record<number, { name?: string }>;
        biomesArray?: Array<{ id: number; name: string }>;
      };
      if (!name && Number.isInteger(id)) name = biomes.biomes?.[id!]?.name || biomes.biomesArray?.find(entry => entry.id === id)?.name || '';
      if (!name) name = 'unknown';
      const dimension = String(bot.game.dimension || 'minecraft:overworld');
      const key = `${dimension}:${name}:${id ?? ''}`;
      if (key === lastBiome) return;
      lastBiome = key;
      socket.emit('biome', { name, dimension, id: Number.isInteger(id) ? id : null });
      weather();
    };
    const biomeTimer = setInterval(biome, 1200);
    const chunkUnload = (position: unknown) => {
      if (active && position && typeof position === 'object') worldView.unloadChunk(position);
    };
    const otherSwing = (entity: ViewerEntity) => {
      if (active && entity && entity !== bot.entity && nearby(entity)) {
        socket.emit('entityAnimation', { id: entity.id, animation: 'oneSwing' });
      }
    };
    const entityHurt = (entity: ViewerEntity) => {
      if (active && entity && (entity === bot.entity || nearby(entity))) {
        socket.emit('entityDamage', { id: entity.id, isSelf: entity === bot.entity });
      }
    };
    const resetWorld = () => {
      if (!active || resetting) return;
      resetting = true;
      socket.emit('viewerReset');
      setTimeout(stop, 50);
    };
    const stop = () => {
      if (!active) return;
      active = false;
      viewerSockets.delete(socket);
      bot.off('move', position); bot.off('forcedMove', forcedPosition);
      bot.off('time', time);
      protocol.off('game_state_change', weather);
      bot.off('respawn', resetWorld);
      bot.off('chunkColumnUnload', chunkUnload);
      bot.off('entitySpawn', entitySpawn); bot.off('entityMoved', entityMoved);
      bot.off('entityUpdate', entityUpdate); bot.off('entityEquip', entityUpdate);
      bot.off('entityGone', removeEntity);
      bot.off('entitySwingArm', otherSwing);
      bot.off('entityHurt', entityHurt);
      stopBossBars();
      protocol.off('craft_progress_bar', onWindowProperty);
      protocol.off('tile_entity_data', onBlockEntityData);
      clearInterval(avatarTimer);
      clearInterval(entityTimer);
      clearInterval(biomeTimer);
      clearInterval(containerTimer);
      clearInterval(scoreboardTimer);
      clearInterval(minimapTimer);
      clearInterval(lightTimer);
      pendingEntities.clear(); knownEntities.clear();
      worldView.removeListenersFromBot(bot);
      sessions.delete(stop);
      socket.disconnect(true);
    };
    sessions.add(stop);
    viewerSockets.add(socket);
    socket.once('disconnect', stop);
    socket.emit('version', bot.version);
    if (latestSkills) socket.emit('skillsState', latestSkills);
    for (const effect of Object.values((bot.entity as unknown as { effects?: Record<number, { id: number; amplifier: number; duration: number }> }).effects ?? {})) {
      socket.emit('presentationEvent', { kind: 'effect', self: true, active: true, id: effect.id,
        ...effectDetails(effect.id), amplifier: effect.amplifier, durationTicks: effect.duration });
    }
    socket.emit('biome', { name: 'unknown', dimension: String(bot.game.dimension || 'minecraft:overworld'), id: null });
    socket.emit(view === 'third' ? 'entity' : 'playerEntity', ownEntity(bot));
    bot.on('move', position); bot.on('forcedMove', forcedPosition);
    bot.on('time', time);
    protocol.on('game_state_change', weather);
    bot.on('respawn', resetWorld);
    bot.on('chunkColumnUnload', chunkUnload);
    bot.on('entitySpawn', entitySpawn); bot.on('entityMoved', entityMoved);
    bot.on('entityUpdate', entityUpdate); bot.on('entityEquip', entityUpdate);
    bot.on('entityGone', removeEntity);
    bot.on('entitySwingArm', otherSwing);
    bot.on('entityHurt', entityHurt);
    worldView.listenToBot(bot);
    for (const entity of Object.values(bot.entities)) entitySpawn(entity);
    flushEntities();
    time(); weather(); publishBossBars(); position(); biome(); publishAvatar(); publishContainer(); publishScoreboard(); publishMinimap(); publishLight();
    void worldView.init(bot.entity.position).then(() => { initialized = true; }).catch(() => socket.disconnect(true));
  }
  first.on('connection', (socket) => accept(socket, 'first'));
  third.on('connection', (socket) => accept(socket, 'third'));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) {
    first.close(); third.close();
    throw error;
  }
  protocol.on('custom_payload', onSkillPacket);
  const initialMana = options.agentMana?.();
  if (initialMana !== undefined) {
    agentManaSeen = true;
    latestSkills = { ...(latestSkills ?? { schemaVersion: 1, skills: [], abilities: [] }),
      mana: initialMana, source: 'plugin', observedAt: Date.now() };
  }
  protocol.on('packet', onPacketObserved);
  protocol.on('world_particles', onParticle);
  protocol.on('explosion', onExplosion);
  protocol.on('world_event', onWorldEvent);
  protocol.on('collect', onCollect);
  protocol.on('entity_effect', onEntityEffect);
  protocol.on('remove_entity_effect', onRemoveEntityEffect);
  protocol.on('set_cooldown', onCooldown);
  protocol.on('advancements', onAdvancements);
  const stopCastCommands = observeViewerCastCommands(bot, onCastCommand);
  bot.on('message', onCastMessage);
  bot.on('message', onViewerMessage);
  bot.on('title', onViewerTitle);
  (bot as unknown as EventEmitter).on('title_times', onViewerTitleTimes);
  (bot as unknown as EventEmitter).on('title_clear', onViewerTitleClear);
  bot.on('actionBar', onViewerActionBar);
  bot.on('death', onViewerDeath);
  bot.on('soundEffectHeard', onViewerSound);

  const stopArmAnimation = observeViewerArmAnimation(protocol, (hand) => {
    if (closed || !bot.entity) return;
    const event = { id: bot.entity.id, isSelf: true, animation: 'oneSwing', hand };
    for (const socket of viewerSockets) if (socket.connected) socket.emit('entityAnimation', event);
  });
  const stopRangedUse = observeViewerRangedUse(protocol, () => bot.heldItem?.name, (event) => {
    if (closed) return;
    for (const socket of viewerSockets) if (socket.connected) socket.emit('rangedUse', event);
  });
  const stopShieldUse = observeViewerShieldUse(protocol, () => bot.inventory?.slots?.[45]?.name,
    (raised) => { shieldRaised = raised; });

  return {
    url: origin,
    async close() {
      if (closed) return;
      closed = true;
      protocol.off('custom_payload', onSkillPacket);
      protocol.off('packet', onPacketObserved);
      protocol.off('world_particles', onParticle);
      protocol.off('explosion', onExplosion);
      protocol.off('world_event', onWorldEvent);
      protocol.off('collect', onCollect);
      protocol.off('entity_effect', onEntityEffect);
      protocol.off('remove_entity_effect', onRemoveEntityEffect);
      protocol.off('set_cooldown', onCooldown);
      protocol.off('advancements', onAdvancements);
      stopCastCommands();
      bot.off('message', onCastMessage);
      bot.off('message', onViewerMessage);
      bot.off('title', onViewerTitle);
      (bot as unknown as EventEmitter).off('title_times', onViewerTitleTimes);
      (bot as unknown as EventEmitter).off('title_clear', onViewerTitleClear);
      bot.off('actionBar', onViewerActionBar);
      bot.off('death', onViewerDeath);
      bot.off('soundEffectHeard', onViewerSound);
      stopShieldUse();
      stopRangedUse();
      stopArmAnimation();
      for (const stop of [...sessions]) stop();
      await Promise.all([new Promise<void>((resolve) => first.close(() => resolve())),
        new Promise<void>((resolve) => third.close(() => resolve()))]);
    },
  };
}
