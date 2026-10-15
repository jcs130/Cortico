/**
 * Persona 与 Memory 控制台的浏览器入口；声明见 ../persona/persona.ts 的 console()。
 */

import type { ConsoleClientBundle } from 'cortico/web/shared/client-panel.ts';
import '../../cormini/console/style.css';
import { historyPanel } from '../../cormini/console/history.ts';
import { createWorkspacePanel } from '../../cormini/console/workspace.ts';
import { memoryPanel } from './memory.ts';
import { planningPanel, dreamPanel } from './background.ts';

const bundle: ConsoleClientBundle = {
  panels: {
    planning: planningPanel,
    dream: dreamPanel,
    workspace: createWorkspacePanel({
      templates: [
        { value: 'blank', label: '空白' },
        { value: 'note', label: '笔记', body: (title) => `# ${title}\n\n` },
        { value: 'viewer', label: '人物档案', body: (title) => `${title}\n\n` },
      ],
      defaultDir: 'viewers',
    }),
    memory: memoryPanel,
    history: historyPanel,
  },
};

export default bundle;
