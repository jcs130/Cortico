import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BotDefinition, BotParts } from 'cortico/bot.ts';
import type { ConfigGroup, CoreConfig, World } from 'cortico/core/types.ts';
import type { LoadedConfig } from 'cortico/deploy.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import type { WorldDeclaration, WorldSection } from 'cortico/world.ts';
import type { TerminalConfigSection } from 'cortico/worlds/terminal/config.ts';
import type { BilibiliConfigSection } from 'cortico/worlds/bilibili/config.ts';
import type { MinecraftConfigSection } from 'cortico/worlds/minecraft/config.ts';
import { BLUEPRINT_COGNITION_DEFAULTS, CortiV } from './persona/persona.ts';
import { FAST_ATTENTION_DEFAULTS } from './persona/attention-adviser.ts';
import { FAST_REFERENCE_DEFAULTS, type FastReferenceConfig } from './persona/reference-adviser.ts';
import { REFERENCE_LIBRARY_DEFAULTS, type ReferenceLibraryConfig } from './persona/reference-library.ts';
import { PLANNING_DEFAULTS, type PlanningConfig } from './persona/planning-review.ts';
import { FOREGROUND_CONTEXT_DEFAULTS, type ForegroundContextConfig } from './persona/foreground-context.ts';
import { DREAM_DEFAULTS, type DreamConfig } from './persona/dream-context.ts';
import { SLEEP_REVIEW_DEFAULTS, type SleepReviewConfig } from './persona/sleep-review.ts';
import { TOOL_CALL_RECOVERY_DEFAULTS, type ToolCallRecoveryConfig } from './persona/tool-call-recovery.ts';
import type { ContextStagePolicy } from '../cormini/persona/persona.ts';
import { contextStageConfigGroup } from '../cormini/persona/config.ts';

const HERE = resolve(import.meta.dirname);

/** 存在方式自述的源文件;控制台「Persona」页可编辑,重载前缀即生效。 */
const ORIENTATION_FILE = resolve(HERE, 'persona/ORIENTATION.md');

/**
 * 这个Persona为之设计的渠道。实现由启动器并进来(仓内目录加扩展),哪些挂载由 config.json 的
 * `worlds.<id>.enabled` 决定,控制台可热切;`vtuber` 与 `asr` 是扩展包,没装时是灰卡。
 */
const DECLARES: readonly WorldDeclaration[] = ['terminal', 'vtuber', 'bilibili', 'asr', 'minecraft', 'mymc', 'pvz', 'canvas'];

/**
 * 上下文与交接容量配置归Persona，控制台表单与 bots/cormini/persona/config.ts 共用。
 */
export const CORTIV_CONTEXT_CONFIG_GROUP: ConfigGroup = contextStageConfigGroup('cortiv');

/** 关闭后台构思时，World 的 cognition 句柄不可用。 */
export const CORTIV_COGNITION_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-cognition',
  owner: 'persona',
  schema: {
    type: 'object',
    title: '后台构思(代想)',
    description:
      '允许 World 请求后台构思并接收结果。同一时刻处理一项，前台继续运行；费用与用量记入「代想」session。',
    properties: {
      'cognition.enabled': {
        type: 'boolean',
        title: '允许 World 请托后台思考',
        'x-hot': true,
        description:
          '开:World 可以请她想事情,普通构思用当前 provider、'
          + '最多 8 轮工具循环、整体 15 分钟封顶。'
          + '关:这个能力对 World 直接消失(不是报错),World 各自走自己的兜底路子。'
          + '改完立刻生效,不用重启。',
      },
      'cognition.maxHistoryTokens': { type: 'integer', minimum: 1024, title: '后台构思近期历史预算(token估算)', 'x-hot': true,
        description: '完整环境契约和当前请求另外保留；旧经历通过工作区按需读取。' },
      'cognition.blueprintProvider': { type: 'string', title: '蓝图设计 provider', 'x-hot': true,
        description: '已注册的 provider 名称；留空使用当前 provider。模型与思考强度由该 provider 配置，普通构思和定向观察保持各自通道。' },
      'cognition.blueprintMaxHistoryTokens': { type: 'integer', minimum: 1024, title: '蓝图设计近期历史预算(token估算)', 'x-hot': true,
        description: '完整环境契约和设计要求另外保留；每次受理时读取，已开始的设计沿用原配置。' },
      'cognition.blueprintMaxOutputTokens': { type: 'integer', minimum: 256, title: '蓝图设计单轮输出上限(token)', 'x-hot': true,
        description: '只作用于蓝图设计 fork，可按层分批交稿；provider 的上下文容量仍是物理上限。' },
    },
  },
};

export const CORTIV_FAST_ATTENTION_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-fast-attention', owner: 'persona',
  schema: {
    type: 'object', title: '快速注意力判断',
    description: '用30秒以内的近距离观察辅助判断身边互动，超时保留原事件；对话与身体行动仍由主意识选择。',
    properties: {
      'fastAttention.enabled': { type: 'boolean', title: '启用快速注意力判断', 'x-hot': true },
      'fastAttention.endpoint': { type: 'string', title: '判断服务地址', 'x-hot': true },
      'fastAttention.timeoutMs': { type: 'integer', minimum: 1, title: '等待上限(毫秒)', 'x-hot': true },
      'fastAttention.minConfidence': { type: 'number', minimum: 0, maximum: 1, title: '最低置信度', 'x-hot': true },
      'fastAttention.cooldownMs': { type: 'integer', minimum: 0, title: '互动提示间隔(毫秒)', 'x-hot': true },
    },
  },
};

export const CORTIV_REFERENCE_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-references', owner: 'persona',
  schema: { type: 'object', title: '按需参考资料',
    description: '常驻主题目录，按需展开候选与单项细节；参考知识和亲历经验分别保留。',
    properties: {
      'references.enabled': { type: 'boolean', title: '启用参考资料', 'x-hot': true },
      'references.indexFiles': { type: 'string', title: '资料索引文件', 'x-hot': true,
        description: '每行一个工作区相对路径。分类与活动取自文件内容，不固定游戏或服务器。' },
      'references.maxContextTokens': { type: 'integer', minimum: 512, title: '当前阅读分支预算(token估算)', 'x-hot': true },
      'fastReference.enabled': { type: 'boolean', title: '启用资料快判断', 'x-hot': true },
      'fastReference.endpoint': { type: 'string', title: '判断服务地址', 'x-hot': true },
      'fastReference.timeoutMs': { type: 'integer', minimum: 1, maximum: 500, title: '等待上限(毫秒)', 'x-hot': true },
      'fastReference.minIntervalMs': { type: 'integer', minimum: 0, title: '查询间隔(毫秒)', 'x-hot': true },
      'fastReference.minConfidence': { type: 'number', minimum: 0, maximum: 1, title: '最低联合置信度', 'x-hot': true },
      'fastReference.maxResultAgeMs': { type: 'integer', minimum: 1, title: '结果有效期(毫秒)', 'x-hot': true },
    } },
};

export const CORTIV_PLANNING_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-planning', owner: 'persona',
  schema: {
    type: 'object', title: '后台长期复盘',
    description: '定期阅读近期行动与Memory，给主意识候选方向或可持久化的活动日程。独立provider的模型与推理强度在provider库配置。',
    properties: {
      'planning.enabled': { type: 'boolean', title: '启用长期复盘', 'x-hot': true },
      'planning.agendaEnabled': { type: 'boolean', title: '生成活动日程候选', 'x-hot': true,
        description: '保存阶段、完成条件和受阻处理；主意识核验后采用。只读后台规划不会执行World动作。' },
      'planning.provider': { type: 'string', title: '复盘provider名称', 'x-hot': true,
        description: '引用已配置provider，空值不运行；不会自动切换主会话模型。' },
      'planning.reflectionProvider': { type: 'string', title: '深入复盘provider名称', 'x-hot': true,
        description: '有明确问题的复盘自动走此通道；留空沿用常规复盘。思考参数由provider配置，前台模型不变。' },
      'planning.reflectionMaxContextTokens': { type: 'integer', minimum: 1024, title: '深入复盘阅读预算(token估算)', 'x-hot': true },
      'planning.reflectionMaxOutputTokens': { type: 'integer', minimum: 1, title: '深入复盘生成上限(token)', 'x-hot': true },
      'planning.reflectionTimeoutMs': { type: 'integer', minimum: 1, title: '深入复盘等待上限(毫秒)', 'x-hot': true },
      'planning.intervalMinutes': { type: 'number', minimum: 0.01, title: '复盘间隔(分钟)', 'x-hot': true },
      'planning.maxContextTokens': { type: 'integer', minimum: 1024, title: '阅读材料预算(token估算)', 'x-hot': true },
      'planning.maxOutputTokens': { type: 'integer', minimum: 1, title: '生成上限(token)', 'x-hot': true },
      'planning.timeoutMs': { type: 'integer', minimum: 1, title: '复盘等待上限(毫秒)', 'x-hot': true },
      'planning.maxResultAgeMs': { type: 'integer', minimum: 1, title: '复盘结果有效期(毫秒)', 'x-hot': true,
        description: '从材料采样开始计时；过期结果不投递，活动记录仍可供后续复盘。' },
      'planning.yieldToForeground': { type: 'boolean', title: '与前台共享provider时让出模型调用', 'x-hot': true },
      'planning.generationWaitTimeoutMs': { type: 'integer', minimum: 1, title: '等待前台空闲上限(毫秒)', 'x-hot': true },
      'planning.memoryFiles': { type: 'string', title: '长期目标与笔记文件', 'x-hot': true,
        description: '每行一个工作区相对路径；只读，缺失文件会在材料里注明。' },
    },
  },
};

export const CORTIV_DREAM_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-dream', owner: 'persona',
  schema: {
    type: 'object', title: '交接后台整理',
    description: '交接后整理Memory。可选阅读预算fallback保留原始归档、按需分页；模型配置引用provider库。',
    properties: {
      'dream.onHandoff': { type: 'boolean', title: '交接后进行深度经历总结', 'x-hot': true,
        description: '关闭时仍保留上下文交接及交接笔记；经历总结可由睡前回顾触发。' },
      'dream.provider': { type: 'string', title: '整理provider名称', 'x-hot': true,
        description: '空值使用现役provider；共享provider可启用前台优先，独立端点在provider库配置。' },
      'dream.maxContextTokens': { type: 'integer', minimum: 0, title: '请求阅读预算(token估算)', 'x-hot': true,
        description: '0关闭节选fallback；含人格和工具定义。当前完整调用组超预算时保留并记诊断。' },
      'dream.maxReadTokensPerRound': { type: 'integer', minimum: 0, title: '每轮读取总预算(token估算)', 'x-hot': true,
        description: '0关闭分页；1至127按128运行，为来源和游标留出空间。完整结果归档，下一轮可用返回的readCursor继续读取。' },
      'dream.maxOutputTokens': { type: 'integer', minimum: 1, title: '每轮生成上限(token)', 'x-hot': true },
      'dream.timeoutMs': { type: 'integer', minimum: 1, title: '整理任务等待上限(毫秒)', 'x-hot': true,
        description: '包括排队、模型调用和重试退避；超时保留已经落盘的内容。' },
      'dream.maxPendingTasks': { type: 'integer', minimum: 0, title: '整理待运行任务上限', 'x-hot': true },
      'dream.yieldToForeground': { type: 'boolean', title: '与前台共享provider时让出模型调用', 'x-hot': true },
      'dream.generationWaitTimeoutMs': { type: 'integer', minimum: 1, title: '等待前台空闲上限(毫秒)', 'x-hot': true },
    },
  },
};

export const CORTIV_SLEEP_REVIEW_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-sleep-review', owner: 'persona',
  schema: {
    type: 'object', title: '睡前经历回顾',
    description: '收到已确认的夜间入睡事实后，提示主意识先开场发言，再在后台总结。每世界游戏日仅提示一次。',
    properties: {
      'sleepReview.enabled': { type: 'boolean', title: '启用睡前回顾', 'x-hot': true },
      'sleepReview.eventTypes': { type: 'string', title: '入睡事件类型', 'x-hot': true,
        description: '每行一个完整World事件类型，例如minecraft.sleep。需要sleeping、world、gameDay和timeOfDay事实；不按聊天正文判断。' },
    },
  },
};

export const CORTIV_FOREGROUND_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-foreground', owner: 'persona',
  schema: {
    type: 'object', title: '即时调用上下文',
    description: '可关闭的短上下文 fallback。即时调用保留环境契约、新输入及近期完整回执；原始记录继续保存，长期复盘独立读取。',
    properties: {
      'foreground.enabled': { type: 'boolean', title: '启用近期上下文', 'x-hot': true },
      'foreground.maxHistoryTokens': { type: 'integer', minimum: 1024, title: '近期历史预算(token估算)', 'x-hot': true,
        description: '不含完整系统前缀和工具定义；未处理输入和原子调用组超预算时完整保留。' },
      'foreground.minRecentRounds': { type: 'integer', minimum: 1, maximum: 16, title: '至少保留的近期轮次', 'x-hot': true },
      'foreground.memoryFiles': { type: 'string', title: '长期记忆索引入口', 'x-hot': true,
        description: '每行一个工作区相对文件路径。最多8份合计4000字符原文节选，独立于近期短笺；完整内容按需读取。空值不增加入口。' },
    },
  },
};

export const CORTIV_TOOL_CALL_RECOVERY_CONFIG_GROUP: ConfigGroup = {
  id: 'cortiv-tool-call-recovery', owner: 'persona',
  schema: {
    type: 'object', title: '工具接口纠错 fallback',
    description: '仅正文模仿可用工具调用时提示一次接口核验，不执行文字参数；连续失败不重复提醒。',
    properties: {
      'toolCallRecovery.enabled': { type: 'boolean', title: '启用工具接口纠错 fallback', 'x-hot': true },
    },
  },
};

export interface CortiVConfig extends CoreConfig {
  /** 阶段长度三项归Persona,摘思维链与首轮对话两项归 core;同住 context 段。 */
  context: CoreConfig['context'] & ContextStagePolicy;
  rounds: { soft: number; hard: number };
  cognition: {
    enabled: boolean; maxHistoryTokens: number;
    blueprintProvider: string; blueprintMaxHistoryTokens: number; blueprintMaxOutputTokens: number;
  };
  fastAttention: typeof FAST_ATTENTION_DEFAULTS;
  references: ReferenceLibraryConfig;
  fastReference: FastReferenceConfig;
  planning: PlanningConfig;
  dream: DreamConfig;
  sleepReview: SleepReviewConfig;
  foreground: ForegroundContextConfig;
  toolCallRecovery: ToolCallRecoveryConfig;
  tick: {
    /** null disables baseline wakeups. */
    intervalMinutes: number | null;
  };
  worlds: {
    terminal: TerminalConfigSection;
    /** 外部包 `cortico-world-vtuber` 的段:形状归那个包,Persona只知道它在。 */
    vtuber: WorldSection & Record<string, unknown>;
    bilibili: BilibiliConfigSection;
    minecraft: MinecraftConfigSection;
    /** 千灯纪专属配置由外部 World 扩展声明，Bot 只保留装配槽位。 */
    mymc: WorldSection & Record<string, unknown>;
    /** 扩展包 `cortico-world-pvz` 的段,同上。 */
    pvz: WorldSection & Record<string, unknown>;
    /** 扩展包 `cortico-world-asr` 的段,同上。 */
    asr: WorldSection & Record<string, unknown>;
    /** 扩展包 `cortico-world-canvas` 的段,同上。 */
    canvas: WorldSection & Record<string, unknown>;
  };
}

function build(loaded: LoadedConfig<CortiVConfig>, worlds: World[]): BotParts<CortiVConfig> {
  const cfg = loaded.config;

  // CortiV(可缇Corti):直播 memory 系统(观众档案首见唤起/软边界速记/交接后并行梦)
  // 是类自身的行为,不走构造开关。
  const persona = new CortiV({
    memoryDir: loaded.memoryDir,
    context: () => cfg.context,
    rounds: { ...cfg.rounds },
    seedConstitution: readFileSync(resolve(HERE, 'persona/CONSTITUTION.seed.md'), 'utf8'),
    worlds: worlds,
    // Persona把它自报为可编辑的静态前缀源(Persona卡),前缀也从它现读。
    orientationFile: ORIENTATION_FILE,
    // 部署侧的自述覆盖:存在就用它,控制台保存也落到那边(见 PromptDocDecl.deploymentPath)。
    orientationOverrideFile: resolve(loaded.rootDir, 'prompts', 'ORIENTATION.md'),
    // 首轮对话是部署者自己写的,与 ORIENTATION 覆盖同住 prompts/;代码包不带。
    firstTurnDir: resolve(loaded.rootDir, 'prompts'),
    // 现读:控制台上关掉,下一次 World 来请托时句柄就已经不在了(不用重启)。
    cognitionEnabled: () => cfg.cognition.enabled,
    cognitionHistoryTokens: () => cfg.cognition.maxHistoryTokens ?? 4000,
    blueprintCognition: () => ({
      provider: cfg.cognition.blueprintProvider ?? BLUEPRINT_COGNITION_DEFAULTS.provider,
      maxHistoryTokens: cfg.cognition.blueprintMaxHistoryTokens ?? BLUEPRINT_COGNITION_DEFAULTS.maxHistoryTokens,
      maxOutputTokens: cfg.cognition.blueprintMaxOutputTokens ?? BLUEPRINT_COGNITION_DEFAULTS.maxOutputTokens,
    }),
    fastAttention: () => cfg.fastAttention ?? FAST_ATTENTION_DEFAULTS,
    references: () => cfg.references ?? REFERENCE_LIBRARY_DEFAULTS,
    fastReference: () => cfg.fastReference ?? FAST_REFERENCE_DEFAULTS,
    planning: () => cfg.planning ?? PLANNING_DEFAULTS,
    dream: () => cfg.dream ?? DREAM_DEFAULTS,
    sleepReview: () => cfg.sleepReview ?? SLEEP_REVIEW_DEFAULTS,
    foreground: () => cfg.foreground ?? FOREGROUND_CONTEXT_DEFAULTS,
    toolCallRecovery: () => cfg.toolCallRecovery ?? TOOL_CALL_RECOVERY_DEFAULTS,
    timezone: () => cfg.timezone,
    tickDelayMs: () =>
      cfg.tick.intervalMinutes === null ? null : cfg.tick.intervalMinutes * 60_000,
  });

  return {
    persona,
    onStart: () => {
      persona.startRhythm();
    },
    onStop: () => {
      persona.stopRhythm();
    },
    console: {
      configGroups: [CORTIV_CONTEXT_CONFIG_GROUP, CORTIV_COGNITION_CONFIG_GROUP,
        CORTIV_FAST_ATTENTION_CONFIG_GROUP, CORTIV_REFERENCE_CONFIG_GROUP, CORTIV_PLANNING_CONFIG_GROUP, CORTIV_DREAM_CONFIG_GROUP, CORTIV_SLEEP_REVIEW_CONFIG_GROUP, CORTIV_FOREGROUND_CONFIG_GROUP,
        CORTIV_TOOL_CALL_RECOVERY_CONFIG_GROUP],
      // 阶段预算与软预警线(终端页上下文圈的分母与黄线);计数与物理上限由 core 报
      status: () => ({ context: { maxTokens: cfg.context.maxTokens, softRatio: cfg.context.softRatio } }),
    },
  };
}

const definition: BotDefinition<CortiVConfig> = {
  id: 'cortiv',
  // 记忆系统与 Cormini 同一套(工作区即记忆,Git 记账)。
  memoryName: 'GitMem',
  declares: DECLARES,
  defaults: () => ({
    ...CORE_DEFAULTS,
    displayName: '可缇Corti',
    // 端点表是全局部署事实(`<部署根>/providers/`),不归代码包。
    providers: {},
    web: { port: 7789, theme: 'navigator' },
    paths: { memory: 'workspace', data: 'data' },
    batching: { ...CORE_DEFAULTS.batching },
    // 交接阈值(塞满多少就交接)。这只是**层 2 建议值** —— config.json 的 context 段
    // 压过它(deploy.ts 的四层深合并),控制台「可缇Corti → 参数」改的也是那一份。
    // 别把它跟 provider 那份 spec 的 contextWindow(模型物理窗口)或 maxTokens
    // (单轮生成上限)搞混:那两样归 provider,Persona拿不到。
    context: { maxTokens: 64000, keepRatio: 1 / 4, softRatio: 0.85, firstTurn: false, ...CORE_DEFAULTS.context },
    tick: { intervalMinutes: 45 },
    // 默认开:蓝图设计就走这条,关掉它 Minecraft 那边的 design 只能如实拒收。
    cognition: {
      enabled: true, maxHistoryTokens: 4000,
      blueprintProvider: BLUEPRINT_COGNITION_DEFAULTS.provider,
      blueprintMaxHistoryTokens: BLUEPRINT_COGNITION_DEFAULTS.maxHistoryTokens,
      blueprintMaxOutputTokens: BLUEPRINT_COGNITION_DEFAULTS.maxOutputTokens,
    },
    fastAttention: { ...FAST_ATTENTION_DEFAULTS },
    references: { ...REFERENCE_LIBRARY_DEFAULTS },
    fastReference: { ...FAST_REFERENCE_DEFAULTS },
    planning: { ...PLANNING_DEFAULTS },
    dream: { ...DREAM_DEFAULTS },
    sleepReview: { ...SLEEP_REVIEW_DEFAULTS },
    foreground: { ...FOREGROUND_CONTEXT_DEFAULTS },
    toolCallRecovery: { ...TOOL_CALL_RECOVERY_DEFAULTS },
    rounds: { soft: 6, hard: 12 },
    // World 段不在这里:实现的默认值由启动器补。人格身份与演出选择
    // (`minecraft.username`、`vtuber.delayedSources`、要不要开视觉)在
    // bots/cortiv/worlds/<id>/config.json,本机事实(凭证、程序路径、设备、开没开)
    // 在这份部署的 config.json。
  } as unknown as CortiVConfig),
  build,
};

export default definition;
