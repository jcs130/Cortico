import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MymcConfigSection } from './config.ts';

export function assertMymcReady(cfg: MymcConfigSection, botDir?: string): void {
  if (!cfg.host.trim() || !cfg.username.trim()) {
    throw new Error('先配置千灯纪的服务器地址与游戏账号');
  }
  if (!botDir) return;
  const file = join(botDir, 'config.json');
  if (!existsSync(file)) return;
  const config = JSON.parse(readFileSync(file, 'utf8')) as {
    worlds?: { minecraft?: { enabled?: boolean } };
  };
  if (config.worlds?.minecraft?.enabled === true) {
    throw new Error('先停用 Minecraft World，再启用千灯纪；两个 World 共用游戏连接');
  }
}
