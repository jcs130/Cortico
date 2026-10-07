/** Server manuals are read by topic; the index needs no manual file reads. */
import { readFileSync } from 'node:fs';

export const MYMC_GUIDE_TOPICS = [
  { id: 'world', title: '世界与自主探索', description: '世界设定、独自生活与活动选择' },
  { id: 'protection', title: '保护与权限', description: '村庄保护、采集拒绝与操作边界' },
  { id: 'travel', title: '传送与抵达', description: '归乡、村庄路标、实际高度与脱困' },
  { id: 'guild', title: '公会委托与共享', description: '看板、接单交付、公共箱与分享装备' },
  { id: 'trial', title: '试炼塔', description: '入场、楼层进度、第七层与通关核验' },
  { id: 'storage', title: '背包与个人奖励箱', description: '开窗存取、腾格、箱账、收纳与领奖' },
  { id: 'tasks', title: '任务执行与受阻', description: '队列、依赖、终态、材料与失败后的调整' },
  { id: 'skills', title: '技能学习与施法', description: '命令目录、技能说明、魔力、冷却与罗盘' },
  { id: 'flight', title: '飞行术', description: '限时飞行、落脚点与同单施法飞行' },
  { id: 'combat', title: '战斗与补给', description: '连招、回血、盾牌图腾、进食与撤离' },
  { id: 'mining', title: '探矿与挖掘', description: '绝对定位、隐藏矿石、安全井口与保护' },
  { id: 'living', title: '种植钓鱼与烹饪', description: '生长回访、岸上钓鱼、熔炉与睡觉' },
  { id: 'building', title: '家与建造', description: '布局、蓝图、施工核验与设计经验' },
  { id: 'social', title: '玩家交往与动作', description: '附近感知、公屏私聊、拜访、挥手与赠物' },
  { id: 'vision', title: '现场视觉观察', description: '按问题选视角、菜单路况与画面证据边界' },
  { id: 'broadcast', title: '直播与加入方式', description: '介绍玩法、内测 QQ 群、事实解说与语音节奏' },
  { id: 'state', title: '当前环境读数', description: '任务、目标、探索、规则与摄像机当前采样' },
] as const;

export type ServerGuideTopic = typeof MYMC_GUIDE_TOPICS[number]['id'];

export function serverGuideIndex(): string {
  return MYMC_GUIDE_TOPICS.map(({ id, title, description }) => `${id}：${title}；${description}`).join('\n');
}

/** Templates remain intact so the World can render them from its current envPromptVars. */
export function readServerGuide(topic?: unknown): { text: string; failed?: true } {
  if (topic === undefined || topic === 'index') return {
    text: `千灯纪玩法索引。用 mymc_guide 的 topic 读取相关全文；规则与命令以当次服务端回执为准。\n${serverGuideIndex()}`,
  };
  const entry = MYMC_GUIDE_TOPICS.find((candidate) => candidate.id === topic);
  if (!entry) return { failed: true, text: `玩法主题无效。省略 topic 查看索引，或使用以下主题：\n${serverGuideIndex()}` };
  const text = readFileSync(new URL(`./guides/${entry.id}.md`, import.meta.url), 'utf8').trim();
  return { text: `# 千灯纪 · ${entry.title}\n\n资料包含已验证机制与操作建议；规则、位置和状态以当前服务端回执为准。\n\n${text}` };
}
