/** 千灯纪的 World 契约；游戏协议与执行器沿用 Minecraft 引擎。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CognitionRequest,
  DeferredRendered,
  ToolDef,
  ToolOutcome,
  World,
  WorldConsoleDecl,
  WorldHost,
  WorldPanelDecl,
} from 'cortico/core/types.ts';
import { MINECRAFT_PANEL_DECLS, MINECRAFT_TOOL_DECLS, type MinecraftWorldOptions } from 'cortico/worlds/minecraft/world.ts';
import { MinecraftWorldProxy } from 'cortico/worlds/minecraft/proxy.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import {
  MYMC_CLIENT_CONFIG_GROUP,
  MYMC_CONFIG_GROUP,
  MYMC_PLAYER_CONFIG_GROUP,
  MYMC_RHYTHM_CONFIG_GROUP,
  type MymcConfigSection,
} from './config.ts';
import { assertMymcReady } from './guard.ts';
import { SkillCatalog } from './skill-catalog.ts';
import { startsTrialFight, trialMeleeReadiness } from './trial-readiness.ts';
import { TrialProgress, trialGoalLimitNote } from './trial-status.ts';
import { ProspectEvidence } from './prospect-evidence.ts';
import { GuildProgress } from './guild-progress.ts';
import { MYMC_GUIDE_TOPICS, readServerGuide, serverGuideIndex } from './server-guide.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const CAMERA_NOTE_FILE = fileURLToPath(new URL('./ENV_PROMPT_CAMERA.md', import.meta.url));

export const MYMC_PANEL_DECLS: readonly WorldPanelDecl[] = MINECRAFT_PANEL_DECLS
  .filter((panel) => panel.id === 'skin' || panel.id === 'log');

function toMymcText(text: string): string {
  return text.replace(/\bmc_([a-z][a-z0-9_]*)\b/g, 'mymc_$1')
    .replace(/\bminecraft\.([a-z][a-z0-9_.]*)/g, 'mymc.$1')
    .replaceAll('worlds.minecraft.', 'worlds.mymc.');
}

function mapSchema(value: unknown): unknown {
  if (typeof value === 'string') return toMymcText(value);
  if (Array.isArray(value)) return value.map(mapSchema);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapSchema(item)]));
  }
  return value;
}

export const MYMC_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [...MINECRAFT_TOOL_DECLS
  .filter((decl) => decl.name !== 'mc_escape')
  .map((decl) => ({
  ...decl,
  name: decl.name.replace(/^mc_/, 'mymc_'),
  description: toMymcText(decl.description),
  parameters: mapSchema(decl.parameters) as Record<string, unknown>,
})), {
  name: 'mymc_skills',
  tags: ['read'],
  description: 'Read the latest observed Qiandengji spell directory. Pass id for a cached full MC_SPELL_DETAIL; use /mycli spells list and /mycli spells explain <ID> to refresh server facts. Current mana and remaining cooldown come from mcagent:state.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'Optional stable spell ID, e.g. flight or frostnova.' } }, required: [] },
}, {
  name: 'mymc_guide',
  tags: ['read'],
  description: 'Read one Qiandengji manual topic when needed. Omit topic for the index. Local guidance records observed mechanisms; current server replies decide rules, locations, costs and availability. Generic Minecraft action parameters are available through mymc_help.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    topic: { type: 'string', enum: ['index', ...MYMC_GUIDE_TOPICS.map(({ id }) => id)] },
  }, required: [] },
}];

function toMymcEvent<T extends { source: string; type: string; text: string; senderKey?: string }>(event: T): T {
  return {
    ...event,
    source: event.source === 'minecraft' ? 'mymc' : event.source,
    type: event.type.replace(/^minecraft\./, 'mymc.'),
    text: toMymcText(event.text),
    ...(event.senderKey !== undefined
      ? { senderKey: event.senderKey.replace(/^minecraft(?=\.|$)/, 'mymc') }
      : {}),
  };
}

function toMinecraftEvent<T extends { source: string; type: string; text: string; senderKey?: string }>(event: T): T {
  return {
    ...event,
    source: event.source === 'mymc' ? 'minecraft' : event.source,
    type: event.type.replace(/^mymc\./, 'minecraft.'),
    ...(event.senderKey !== undefined
      ? { senderKey: event.senderKey.replace(/^mymc(?=\.|$)/, 'minecraft') }
      : {}),
  };
}

function mapRendered(rendered: DeferredRendered | null): DeferredRendered | null {
  if (typeof rendered === 'string') return toMymcText(rendered);
  return rendered ? { ...rendered, text: toMymcText(rendered.text) } : null;
}

/** 千灯纪服务端已实测可用的快捷抵达点。添加新地点只需扩这张表。 */
const FAST_TRAVEL = [
  { name: '试炼场入口', target: { x: -594, y: 91, z: -313 }, radius: 4,
    landing: [-590, 91, -322], command: '/mycli goto arena' },
  { name: '出生村庄', target: { x: -544, y: 66, z: -440 }, radius: 5,
    landing: [-544, 66, -440], command: '/mycli goto village' },
] as const;

export function routeViaServerCommand(args: Record<string, unknown>): { args: Record<string, unknown>; note: string | null } {
  if (!Array.isArray(args.steps)) return { args, note: null };
  let correctedGlowBerries = false;
  const steps = (args.steps as unknown[]).map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const step = raw as Record<string, unknown>;
    if (typeof step.item !== 'string'
      || !['glowing_berries', 'minecraft:glowing_berries', '发光浆果'].includes(step.item)) return raw;
    correctedGlowBerries = true;
    return { ...step, item: 'glow_berries' };
  });
  const itemNote = correctedGlowBerries
    ? '已把发光浆果的物品名改为原版 ID glow_berries；glowing_berries 不是真实物品 ID。'
    : null;
  // The bare command opens a GUI, then the task boundary closes it before the
  // agent can inspect it. The text fallback reports only rewards queued by a
  // full chest, not the current contents of the private chest.
  if (steps.length === 1) {
    const only = steps[0];
    if (only && typeof only === 'object' && !Array.isArray(only)) {
      const step = only as Record<string, unknown>;
      if (step.skill === 'chat' && typeof step.text === 'string'
        && /^\/mycli\s+arena\s+rewards\s*$/i.test(step.text)) {
        return {
          args: { ...args, steps: [{ ...step, text: '/mycli arena rewards list' }] },
          note: '单独打开个人奖励箱只会闪现界面；已改查箱满后尚未入箱的奖励。此清单不反映个人箱内物品或空位；取物时把打开窗口和 take from:"open" 放在同一单。',
        };
      }
    }
  }
  const out: Array<{ step: unknown; origin: number | null; needs: number[] | null; travel: number | null }> = [];
  const originalToNew = new Map<number, number>();
  let note: string | null = null;
  for (const [index, raw] of steps.entries()) {
    const original = index + 1;
    let travel: number | null = null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const step = raw as Record<string, unknown>;
      if (step.skill === 'goto' && Array.isArray(step.at) && step.at.length === 3
        && step.at.every((n) => typeof n === 'number' && Number.isInteger(n))
        && (!step.dimension || step.dimension === 'minecraft:overworld' || step.dimension === 'overworld')) {
        const [x, y, z] = step.at as number[];
        const route = FAST_TRAVEL.find((entry) =>
          Math.hypot(x - entry.target.x, y - entry.target.y, z - entry.target.z) <= entry.radius
          || Math.hypot(x - entry.landing[0], y - entry.landing[1], z - entry.landing[2]) <= entry.radius);
        const previous = out[out.length - 1];
        const previousStep = previous?.step as Record<string, unknown> | undefined;
        if (route) {
          const action = { skill: 'server_travel', command: route.command, at: [...route.landing], within: 3 };
          if (previousStep?.skill === 'server_travel' && previousStep.command === route.command) {
            travel = out.length;
          } else if (previousStep?.skill === 'chat' && previousStep.text === route.command) {
            previous.step = action;
            travel = out.length;
          } else {
            out.push({ step: action, origin: null,
              needs: Array.isArray(step.needs) ? step.needs as number[] : null, travel: null });
            travel = out.length;
          }
          note = `去${route.name}的任务已先加服务端快捷抵达命令 ${route.command}`;
        }
      }
    }
    out.push({ step: raw, origin: original,
      needs: raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).needs)
        ? (raw as { needs: number[] }).needs : null,
      travel });
    originalToNew.set(original, out.length);
  }
  if (!note && !itemNote) return { args, note: null };
  const rewritten = out.map(({ step, needs, travel }) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    if (needs === null && travel === null) return step;
    const mapped = needs?.map((n) => originalToNew.get(n) ?? n) ?? [];
    if (travel !== null && !mapped.includes(travel)) mapped.push(travel);
    return { ...step, needs: mapped };
  });
  return { args: { ...args, steps: rewritten }, note: [itemNote, note].filter(Boolean).join('\n') };
}

function mymcHost(host: WorldHost, catalog: SkillCatalog, progress: TrialProgress,
  prospect: ProspectEvidence, guild: GuildProgress): WorldHost {
  const bridge = Object.create(host) as WorldHost;
  bridge.pushEvent = async (event, options) => {
    const mapped = toMymcEvent(event);
    const saved = await host.pushEvent(mapped, options);
    if (mapped.type === 'mymc.chat') {
      prospect.observe(mapped.text, mapped.ts);
      progress.observe(mapped.text, mapped.ts);
      guild.observe(mapped.text, mapped.ts);
      const heading = catalog.observe(mapped.text, mapped.ts);
      if (heading) {
        await host.pushEvent({
          ts: mapped.ts, source: 'mymc', type: 'mymc.skill', senderKey: 'mymc.skills',
          text: `[千灯纪] 服务端技能目录「${heading}」有变化。用 mymc_skills 读取服务端原话，再决定是否学习或调整用法。`,
        }, { trigger: 'piggyback' });
      }
    }
    return toMinecraftEvent(saved);
  };
  bridge.pushDeferred = (event, options) => host.pushDeferred({
    ...event,
    type: event.type.replace(/^minecraft\./, 'mymc.'),
    ...(event.senderKey !== undefined
      ? { senderKey: event.senderKey.replace(/^minecraft(?=\.|$)/, 'mymc') }
      : {}),
    render: async () => mapRendered(await event.render()),
  }, options);
  bridge.drainPendingEvents = async (filter) => {
    const events = await host.drainPendingEvents((event) => filter(toMinecraftEvent(event)));
    return events.map(toMinecraftEvent);
  };
  bridge.reportUsage = (usage, options) => host.reportUsage(usage, options);
  Object.defineProperty(bridge, 'cognition', {
    get: () => {
      const cognition = host.cognition;
      return cognition && {
        request: (request: CognitionRequest) => cognition.request({
          ...request,
          brief: toMymcText(request.brief),
          tools: request.tools?.map((name) => name.replace(/^mc_/, 'mymc_')),
        }),
      };
    },
  });
  return bridge;
}

export class MymcWorld implements World {
  readonly id = 'mymc';
  private readonly engine: MinecraftWorldProxy;
  private readonly catalog: SkillCatalog;
  private readonly trialProgress: TrialProgress;
  private readonly guildProgress: GuildProgress;
  private readonly prospect = new ProspectEvidence();
  private readonly requireProtectSupport: boolean;

  constructor(private readonly opts: Omit<MinecraftWorldOptions, 'cfg'> & { cfg: MymcConfigSection; botDir?: string }, engine?: MinecraftWorldProxy) {
    this.requireProtectSupport = engine === undefined;
    // The local engine supports this capability; the published Cortico 0.1.4 type has not caught up.
    this.engine = engine ?? new MinecraftWorldProxy({ ...opts, agentFriendEnabled: true } as MinecraftWorldOptions);
    this.catalog = new SkillCatalog(`${opts.cfg.host}:${opts.cfg.port}`, opts.dataDir);
    this.trialProgress = new TrialProgress(`${opts.cfg.host}:${opts.cfg.port}:${opts.cfg.username}`, opts.dataDir);
    this.guildProgress = new GuildProgress(`${opts.cfg.host}:${opts.cfg.port}:${opts.cfg.username}`, opts.dataDir);
  }

  envPromptVars(): Record<string, string> {
    const vars = this.engine.envPromptVars();
    const mymc = Object.fromEntries(Object.entries(vars)
      .map(([key, value]) => [key.replace(/^minecraft\./, 'mymc.'), toMymcText(value)]));
    mymc['mymc.version'] = this.opts.cfg.version;
    mymc['mymc.guide_index'] = serverGuideIndex();
    mymc['mymc.guild_state'] = this.guildProgress.facts();
    mymc['mymc.trial_progress'] = this.trialProgress.clear
      ? `历史实证：${this.trialProgress.clear.at} 已通关第 ${this.trialProgress.clear.floor}/${this.trialProgress.clear.maxFloor} 层。最新一次 lastOutcome 可能被新开或中断的一局覆盖，不撤销这次通关。`
      : '尚未留存试炼全通的服务端回执。';
    mymc['mymc.camera'] = this.opts.cfg.client.enabled
      ? readFileSync(CAMERA_NOTE_FILE, 'utf8').trim()
      : '';
    return mymc;
  }

  verifiedFacts(): string | null {
    const clear = this.trialProgress.clear;
    return [clear ? `服务端回执 ${clear.at}：试炼已通关第 ${clear.floor}/${clear.maxFloor} 层。` : '',
      this.guildProgress.facts()].filter(Boolean).join('\n') || null;
  }

  requestFacts() {
    const engine = this.engine as MinecraftWorldProxy & {
      requestFacts?: () => { text: string; snapshotTypes: readonly string[];
        parts?: readonly { key: string; text: string }[] } | null;
    };
    const facts = engine.requestFacts?.();
    const additions = [{ key: 'skillCatalog', text: this.catalog.compactIndex() },
      { key: 'guildState', text: this.guildProgress.facts() }].filter(part => part.text);
    return facts ? {
      text: [toMymcText(facts.text), ...additions.map(part => part.text)].join('\n'),
      ...(facts.parts?.length ? { parts: [...facts.parts.map(part => ({ ...part, text: toMymcText(part.text) })),
        ...additions] } : {}),
      snapshotTypes: facts.snapshotTypes.map((type) => type.replace(/^minecraft\./, 'mymc.')),
    } : null;
  }

  tools(): ToolDef[] {
    const engineTools = this.engine.tools();
    const bagTool = engineTools.find((tool) => tool.name === 'mc_bag');
    return [...engineTools.filter((tool) => tool.name !== 'mc_escape').map((tool): ToolDef => ({
      ...tool,
      name: tool.name.replace(/^mc_/, 'mymc_'),
      description: toMymcText(tool.description),
      parameters: mapSchema(tool.parameters) as Record<string, unknown>,
      handler: async (args, ctx) => {
        if (tool.name === 'mc_cast' && typeof args.spell === 'string') {
          const id = args.spell.trim().toLowerCase();
          const command = this.catalog.commandFor(id);
          const prefix = `/mycli cast ${id}`;
          if (command !== null && command !== prefix && !command.startsWith(`${prefix} `)) {
            return { text: `[mymc_cast 未发送] 服务端为 ${id} 声明的命令是 ${command}，不属于本工具的 cast 用法。`
              + `用 mymc_skills {"id":"${id}"} 核对说明，按实际参数填写该命令并通过 mymc_do 的 chat 步骤发送；生效以服务端回执为准。`, failed: true };
          }
          const required = this.catalog.requiredArgumentCount(args.spell);
          const supplied = Array.isArray(args.arguments) ? args.arguments.length : 0;
          if (required !== null && supplied < required) {
            return { text: `[mymc_cast 未发送] 服务端已观测的 ${args.spell} 用法需要至少 ${required} 个参数；`
              + `用 mymc_skills {"id":"${args.spell}"} 或 /mycli spells explain ${args.spell} 核对完整说明，按实际值填写 arguments。`, failed: true };
          }
          const maximum = this.catalog.maximumArgumentCount(args.spell);
          if (maximum !== null && supplied > maximum) {
            return { text: `[mymc_cast 未发送] 服务端已观测的 ${args.spell} 用法最多接受 ${maximum} 个参数，本次给了 ${supplied} 个；`
              + `用 mymc_skills {"id":"${args.spell}"} 或 /mycli spells explain ${args.spell} 核对完整说明；目录更新后按新用法调用。`, failed: true };
          }
        }
        if (tool.name === 'mc_goal') {
          const limit = trialGoalLimitNote(args as Record<string, unknown>, this.trialProgress.status, this.trialProgress.clear);
          if (limit) return { text: `[mymc_goal 未受理] ${limit}`, failed: true, endsTurn: true, retryAfterMs: 30_000 };
        }
        if (tool.name === 'mc_do' && startsTrialFight(args as Record<string, unknown>)) {
          // An internal read skips the per-round display gate. A prior mymc_bag
          // call in this round must not hide the current loadout from the guard.
          const bagResult = bagTool
            ? await bagTool.handler({}, { ...ctx, round: undefined })
            : '[mc_bag 失败] 装备读数不可用';
          const bag = typeof bagResult === 'string' ? bagResult : bagResult.text;
          const readiness = trialMeleeReadiness(bag);
          if (readiness !== 'ready') {
            const reason = readiness === 'missing'
              ? '随身没有剑或斧。铁镐、空手、弓弩和少量箭不能替代试炼塔近战主武器。先从储物箱取出剑或斧，再核对背包后入塔。'
              : '无法确认当前随身武器；等物品栏同步后重试。';
            return `[mymc_do 未受理] 入塔装备检查：${reason}\n${toMymcText(bag)}`;
          }
        }
        if (tool.name === 'mc_do') {
          const reason = this.prospect.redundantProbe(args as Record<string, unknown>);
          if (reason) return { text: `[mymc_do 未受理] ${reason}`, failed: true, endsTurn: true };
        }
        const planned = tool.name === 'mc_do'
          ? routeViaServerCommand(args as Record<string, unknown>)
          : { args, note: null };
        const result = await tool.handler(planned.args, ctx);
        const addNote = (value: string): string => planned.note ? `${planned.note}\n${value}` : value;
        return typeof result === 'string'
          ? addNote(toMymcText(result))
          : { ...result, text: addNote(toMymcText((result as ToolOutcome).text)) };
      },
    })), {
      ...MYMC_TOOL_DECLS.find((decl) => decl.name === 'mymc_skills')!,
      handler: async (args) => this.catalog.readout(typeof args.id === 'string' ? args.id : undefined),
    }, {
      ...MYMC_TOOL_DECLS.find((decl) => decl.name === 'mymc_guide')!,
      handler: async (args) => {
        const outcome = readServerGuide(args.topic);
        return { ...outcome, text: renderTemplate(outcome.text, this.envPromptVars()) };
      },
    }];
  }

  console(): WorldConsoleDecl {
    const base = this.engine.console();
    return {
      ...base,
      label: '千灯纪',
      panels: [...MYMC_PANEL_DECLS],
      promptDocs: [
        {
          key: 'worlds.mymc.envPrompt',
          title: '千灯纪 · 环境提示词',
          description: '服务器规则与工具使用。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'mymc.version', description: '连接的协议版本。' },
            { name: 'mymc.guide_index', description: '按需读取的服务器玩法主题。', multiline: true },
            { name: 'mymc.world', description: '当前服务器或存档的身份。' },
            { name: 'mymc.explored', description: '探索覆盖摘要。' },
            { name: 'mymc.policy', description: '与默认值不同的常驻规则。' },
            { name: 'mymc.camera', description: '观察者摄像机说明；未启用时为空。', multiline: true },
            { name: 'mymc.current_task', description: '引擎同步的当前任务；状态变动后约一秒更新。' },
            { name: 'mymc.goals', description: '引擎同步的目标摘要；状态变动后约一秒更新。' },
            { name: 'mymc.trial_progress', description: '历史服务端全通回执；与最近一次试炼状态分开记录。' },
            { name: 'mymc.guild_state', description: '带时间的服务端在办委托与近期完成证据。' },
          ],
        },
        {
          key: 'worlds.mymc.cameraNote',
          title: '千灯纪 · 摄像机说明',
          description: '观察者客户端开启时追加到环境提示词。',
          path: CAMERA_NOTE_FILE,
        },
      ],
      storage: base.storage?.map((part) => ({
        ...part,
        key: part.key.replace(/^minecraft-/, 'mymc-'),
      })),
      config: [
        MYMC_CONFIG_GROUP,
        MYMC_RHYTHM_CONFIG_GROUP,
        MYMC_CLIENT_CONFIG_GROUP,
        MYMC_PLAYER_CONFIG_GROUP,
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    if (this.opts.botDir) assertMymcReady(this.opts.cfg, this.opts.botDir);
    if (this.requireProtectSupport) {
      const availableTools = new Set(this.engine.tools().map((tool) => tool.name));
      const missingTools = ['mc_cast', 'mc_combat_tactic'].filter((name) => !availableTools.has(name));
      if (missingTools.length > 0) {
        throw new Error(`当前 Cortico Minecraft 引擎缺少千灯纪使用的工具：${missingTools.join(', ')}`);
      }
      const protectionModule = 'cortico/worlds/minecraft/agentfriend-protection.ts';
      try {
        await import(protectionModule);
      } catch {
        throw new Error('当前 Cortico 构建缺少 AgentFriend 方块保护预检；请先升级 Minecraft 引擎');
      }
    }
    await this.engine.start(mymcHost(host, this.catalog, this.trialProgress, this.prospect, this.guildProgress));
  }

  stop(): Promise<void> {
    return this.engine.stop();
  }
}
