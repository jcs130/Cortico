/** Load an explicit deployment credential allowlist before entering the ordinary Node CLI. */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const configPath = args[0] === '--bootstrap-config'
  ? args.splice(0, 2)[1] : resolve(dirname(fileURLToPath(import.meta.url)), 'bootstrap.json');
if (!configPath) throw new Error('Missing bootstrap configuration path');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (!isAbsolute(config.entry ?? '') || !isAbsolute(config.envFile ?? '')
  || !Array.isArray(config.environmentKeys) || !config.environmentKeys.length
  || config.environmentKeys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
  throw new Error('Invalid explicit entry, environment file or variable allowlist');
}
const values = parseEnv(readFileSync(config.envFile, 'utf8'));
for (const key of config.environmentKeys) {
  if (!values[key]) throw new Error(`Configured credential variable is missing: ${key}`);
  process.env[key] = values[key];
}
// Preserve the CLI's ordinary main-module guard and all application arguments.
if (config.refreshPrefixOnStartup) {
  const { refreshStartupPrefix } = await import('./startup-prefix.mjs');
  void refreshStartupPrefix(config.refreshPrefixOnStartup)
    .then(() => console.info('[bootstrap] Persona prefix initialized'))
    .catch(() => console.warn('[bootstrap] Persona prefix initialization unconfirmed'));
}
process.argv = [process.execPath, config.entry, ...args];
await import(pathToFileURL(config.entry).href);
