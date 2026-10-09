/** Builds against the installed Fabric client's actual intermediary API. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const gameDir = args[0] && resolve(args[0]);
const javaHomeAt = args.indexOf('--java-home');
const javaHome = javaHomeAt >= 0 ? args[javaHomeAt + 1] : process.env.JAVA_HOME;
if (!gameDir || !existsSync(join(gameDir, '.fabric', 'remappedJars'))) {
  throw new Error('Usage: node scripts/build-minecraft-chat-filter.mjs <gameDir> [--java-home <JDK21Dir>] [--install]. Launch Fabric 1.20.6 once first.');
}
const work = join(root, 'scratch', 'native-chat-filter');
const classes = join(work, 'classes');
const deps = join(work, 'deps');
mkdirSync(classes, { recursive: true });
mkdirSync(deps, { recursive: true });
const executable = (name) => javaHome ? join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
function run(name, argv, cwd = root) {
  const result = spawnSync(executable(name), argv, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stdout}\n${result.stderr}`);
  if (result.stdout.trim()) process.stdout.write(result.stdout);
}
function jars(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? jars(file) : entry.name.endsWith('.jar') ? [file] : [];
  });
}
const api = jars(join(gameDir, 'mods')).find((file) => /fabric-api-[^/\\]+\+1\.20\.6\.jar$/.test(file));
const minecraft = jars(join(gameDir, '.fabric', 'remappedJars')).find((file) =>
  file.includes('minecraft-1.20.6-') && file.endsWith('client-intermediary.jar'));
if (!api || !minecraft) throw new Error('Fabric API and a cached Minecraft 1.20.6 intermediary client are required.');
run('jar', ['--extract', '--file', api], deps);
const classpath = [minecraft, ...jars(join(gameDir, 'libraries')), ...jars(join(deps, 'META-INF', 'jars'))].join(delimiter);
const owner = join(root, 'src', 'worlds', 'minecraft', 'native-chat-filter');
const check = join(root, 'tests', 'worlds', 'minecraft', 'native-chat-filter', 'ChatFilterCheck.java');
const quoteArg = (value) => `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
const javacArgs = ['--release', '21', '-encoding', 'UTF-8', '-proc:none', '-classpath', classpath, '-d', classes,
  join(owner, 'CorticoChatFilter.java'), check];
const argFile = join(work, 'javac.args');
writeFileSync(argFile, javacArgs.map(quoteArg).join('\n') + '\n');
run('javac', ['@' + argFile]);
run('java', ['-cp', classes + delimiter + classpath, 'ChatFilterCheck']);
const manifest = JSON.parse(readFileSync(join(owner, 'fabric.mod.json'), 'utf8'));
const output = join(work, `${manifest.id}-${manifest.version}-mc1.20.6.jar`);
run('jar', ['--create', '--file', output, '-C', classes, 'org', '-C', owner, 'fabric.mod.json']);
if (args.includes('--install')) {
  const target = join(gameDir, 'mods', `${manifest.id}.jar`);
  copyFileSync(output, target);
  console.log(`Installed ${target}; reload only this native client to activate.`);
} else console.log(output);
