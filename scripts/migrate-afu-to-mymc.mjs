import { randomUUID } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, writeFileSync, constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const [fileArg, option] = process.argv.slice(2);
if (!fileArg || (option && option !== '--apply') || process.argv.length > 4) {
  console.error('Usage: node scripts/migrate-afu-to-mymc.mjs <deployment-config.json> [--apply]');
  process.exitCode = 2;
} else {
  try {
    const file = resolve(fileArg);
    const source = readFileSync(file, 'utf8');
    const config = JSON.parse(source);
    if (!config?.worlds || !Object.hasOwn(config.worlds, 'afu')) {
      console.log('worlds.afu is absent; nothing to migrate');
    } else if (Object.hasOwn(config.worlds, 'mymc')) {
      throw new Error('worlds.mymc already exists; resolve the two sections before migration');
    } else if (option !== '--apply') {
      console.log('Would rename worlds.afu to worlds.mymc; pass --apply to write a backup and update the config');
    } else {
      config.worlds = Object.fromEntries(Object.entries(config.worlds)
        .map(([key, value]) => [key === 'afu' ? 'mymc' : key, value]));
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const output = JSON.stringify(config, null, 2).replaceAll('\n', newline)
        + (source.endsWith('\n') ? newline : '');
      const backup = `${file}.bak-afu-mymc-${Date.now()}`;
      copyFileSync(file, backup, constants.COPYFILE_EXCL);
      const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
      writeFileSync(temp, output, { flag: 'wx' });
      renameSync(temp, file);
      console.log(`Renamed worlds.afu to worlds.mymc; backup: ${backup}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
