import type { ConsoleClientBundle } from 'cortico/web/shared/client-panel.ts';
import minecraftBundle from 'cortico/worlds/minecraft/console/client.ts';

const bundle: ConsoleClientBundle = {
  panels: {
    skin: minecraftBundle.panels.skin,
    log: minecraftBundle.panels.log,
  },
};

export default bundle;
