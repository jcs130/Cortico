import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installServerLogin, readProtectedCredential } from '../../../src/worlds/minecraft/server-login.mjs';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'server-login-')); dirs.push(dir);
  const credential = join(dir, 'credential'), configFile = join(dir, 'accounts.json');
  writeFileSync(credential, 'fixture-pass');
  const account = { server: 'example.test:25565', username: 'Agent', credentialFile: credential, command: 'login',
    requestMarkers: ['AUTH_LOGIN'], successMarkers: ['AUTH_SUCCESS'], failureMarkers: ['AUTH_FAILED', 'AUTH_2FA'] };
  writeFileSync(configFile, JSON.stringify({ enabled: true, accounts: [account] }));
  const sent: string[] = [], reports: unknown[] = [];
  const bot = Object.assign(new EventEmitter(), { chat: (text: string) => sent.push(text) });
  const messages = (text: string, position = 'system') => bot.emit('message', { toString: () => text }, position);
  const options = { server: 'example.test', username: 'Agent', configFile,
    readCredential: (file: string) => readFile(file), report: (status: unknown) => reports.push(status) };
  return { dir, credential, configFile, account, bot, sent, reports, messages, options };
}
async function settle(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('authentication callback timeout'); await new Promise(r => setTimeout(r, 10)); }
}
describe('scoped automatic server authentication', () => {
  it('submits once per connection, confirms separately and never reports the credential', async () => {
    const r = fixture(), login = installServerLogin(r.bot, r.options);
    r.messages('AUTH_LOGIN: required', 'chat'); r.messages('<Player> AUTH_LOGIN: required');
    expect(r.sent).toEqual([]);
    r.messages('§a[AUTH_LOGIN] required'); r.messages('AUTH_LOGIN: repeated');
    await settle(() => r.sent.length === 1);
    expect(r.sent).toEqual(['/login fixture-pass']);
    expect(login.status()).toEqual({ stage: 'submitted', attempted: true });
    r.messages('AUTH_LOGIN: repeated'); r.messages('AUTH_SUCCESS: welcome');
    expect(login.status().stage).toBe('confirmed');
    expect(JSON.stringify(r.reports)).not.toContain('fixture-pass');
    r.bot.emit('end'); expect(r.bot.listenerCount('message')).toBe(0);
    const second = fixture(); installServerLogin(second.bot, second.options); second.messages('AUTH_LOGIN');
    await settle(() => second.sent.length === 1);
  });
  it('does not read credentials for another account/server or duplicate account configuration', async () => {
    for (const options of [{ server: 'elsewhere.test' }, { username: 'Other' }]) {
      const r = fixture(); installServerLogin(r.bot, { ...r.options, ...options }); r.messages('AUTH_LOGIN');
      await new Promise(resolve => setTimeout(resolve, 20)); expect(r.sent).toEqual([]);
    }
    const r = fixture(); writeFileSync(r.configFile, JSON.stringify({ enabled: true, accounts: [r.account, r.account] }));
    const login = installServerLogin(r.bot, r.options); r.messages('AUTH_LOGIN');
    expect(login.status().stage).toBe('blocked'); expect(r.sent).toEqual([]);
  });
  it('halts on failure/2FA and cancels a credential read when the connection ends', async () => {
    for (const marker of ['AUTH_FAILED', 'AUTH_2FA']) {
      const r = fixture(), login = installServerLogin(r.bot, r.options);
      r.messages(marker); r.messages('AUTH_LOGIN'); expect(login.status().stage).toBe('blocked'); expect(r.sent).toEqual([]);
    }
    const r = fixture(); installServerLogin(r.bot, r.options);
    r.messages('AUTH_LOGIN'); r.bot.emit('end');
    await new Promise(resolve => setTimeout(resolve, 30)); expect(r.sent).toEqual([]);
    const unreadable = fixture(); rmSync(unreadable.credential);
    const login = installServerLogin(unreadable.bot, unreadable.options); unreadable.messages('AUTH_LOGIN');
    await settle(() => login.status().stage === 'blocked'); unreadable.messages('AUTH_LOGIN'); expect(unreadable.sent).toEqual([]);
  });
  it.skipIf(process.platform !== 'win32')('reads a real current-user DPAPI credential without plaintext process arguments', async () => {
    const r = fixture(), encrypted = join(r.dir, 'private.dpapi');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes($env:CORTICO_TEST_VALUE); [IO.File]::WriteAllBytes($env:CORTICO_TEST_FILE,[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)); [Array]::Clear($bytes,0,$bytes.Length)'],
    { windowsHide: true, env: { ...process.env, CORTICO_TEST_VALUE: 'fixture-value', CORTICO_TEST_FILE: encrypted } });
    const bytes = await readProtectedCredential(encrypted);
    try { expect(bytes.toString('utf8')).toBe('fixture-value'); } finally { bytes.fill(0); }
  });
});
