import type { ConfigGroup } from 'cortico/core/types.ts';
import {
  MINECRAFT_CLIENT_CONFIG_GROUP,
  MINECRAFT_CONFIG_GROUP,
  MINECRAFT_DEFAULTS,
  MINECRAFT_PLAYER_CONFIG_GROUP,
  MINECRAFT_RHYTHM_CONFIG_GROUP,
  type MinecraftConfigSection,
} from 'cortico/worlds/minecraft/config.ts';

type RepeatSuccessFallback = {
  enabled: boolean;
  skillsCsv: string;
  maxSuccesses: number;
  windowMinutes: number;
};

export type MymcConfigSection = MinecraftConfigSection & {
  repeatSuccessFallback: RepeatSuccessFallback;
};

const REPEAT_SUCCESS_FALLBACK_DEFAULTS: RepeatSuccessFallback = {
  enabled: false,
  skillsCsv: '',
  maxSuccesses: 3,
  windowMinutes: 15,
};

const baseRepeatSuccessFallback = (MINECRAFT_DEFAULTS as {
  repeatSuccessFallback?: Partial<RepeatSuccessFallback>;
}).repeatSuccessFallback;

export const MYMC_DEFAULTS: MymcConfigSection = {
  ...structuredClone(MINECRAFT_DEFAULTS),
  // The linked Cortico package can predate this Minecraft option.
  repeatSuccessFallback: { ...REPEAT_SUCCESS_FALLBACK_DEFAULTS, ...baseRepeatSuccessFallback },
  enabled: false,
  host: '',
  username: '',
  viewerPort: 7793,
  escapeCommand: '/mycli goto arena',
  local: { ...MINECRAFT_DEFAULTS.local, serverEnabled: false, cheats: false },
  player: { ...MINECRAFT_DEFAULTS.player, teleportToBot: false },
} as MymcConfigSection;

function mymcGroup(base: ConfigGroup, title: string): ConfigGroup {
  return {
    ...base,
    id: base.id.replace('world:minecraft', 'world:mymc'),
    owner: 'world:mymc',
    schema: {
      ...base.schema,
      title,
      properties: Object.fromEntries(Object.entries(base.schema.properties)
        .filter(([path]) => !path.startsWith('worlds.minecraft.local.'))
        .map(([path, property]) => [path.replace('worlds.minecraft.', 'worlds.mymc.'), property])),
    },
  };
}

export const MYMC_CONFIG_GROUP = mymcGroup(MINECRAFT_CONFIG_GROUP, '千灯纪 · 连接');
const rhythmGroup = mymcGroup(MINECRAFT_RHYTHM_CONFIG_GROUP, '千灯纪 · 节奏与反射');
export const MYMC_RHYTHM_CONFIG_GROUP: ConfigGroup = {
  ...rhythmGroup,
  schema: {
    ...rhythmGroup.schema,
    properties: {
      // Newer Cortico already supplies these paths; its schema takes precedence.
      'worlds.mymc.repeatSuccessFallback.enabled': {
        type: 'boolean', title: '同类成功任务暂缓', 'x-hot': true,
        description: '模型失效时的可选兜底；达到次数后，只暂缓列出的目标技能。默认关闭。',
      },
      'worlds.mymc.repeatSuccessFallback.skillsCsv': {
        type: 'string', title: '暂缓目标技能', 'x-hot': true,
        description: '英文技能名用逗号分隔，例如 fish,collect；留空时不暂缓。',
      },
      'worlds.mymc.repeatSuccessFallback.maxSuccesses': {
        type: 'integer', title: '窗口内允许成功次数', minimum: 2, maximum: 20, 'x-hot': true,
      },
      'worlds.mymc.repeatSuccessFallback.windowMinutes': {
        type: 'integer', title: '成功计数窗口', minimum: 1, maximum: 60,
        'x-suffix': '分钟', 'x-hot': true,
      },
      ...rhythmGroup.schema.properties,
    },
  },
};
export const MYMC_CLIENT_CONFIG_GROUP = mymcGroup(MINECRAFT_CLIENT_CONFIG_GROUP, '千灯纪 · 观察者客户端');
export const MYMC_PLAYER_CONFIG_GROUP = mymcGroup(MINECRAFT_PLAYER_CONFIG_GROUP, '千灯纪 · 玩家客户端');
