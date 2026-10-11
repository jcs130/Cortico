/** Scoped server authentication; no credential or submitted command enters the event/context log. */
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

export function readProtectedCredential(file) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('unsupported credential platform')); return; }
    const script = "Add-Type -AssemblyName System.Security; $cipher=[IO.File]::ReadAllBytes($env:CORTICO_MC_CREDENTIAL_FILE); if($cipher.Length -lt 1 -or $cipher.Length -gt 16384){throw 'Credential size'}; $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); try {[Convert]::ToBase64String($plain)} finally {[Array]::Clear($plain,0,$plain.Length)}";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 5000, maxBuffer: 32768, encoding: 'utf8',
      env: { ...process.env, CORTICO_MC_CREDENTIAL_FILE: file },
    }, (error, stdout) => {
      if (error) { reject(new Error('private credential unavailable')); return; }
      resolve(Buffer.from(stdout.trim(), 'base64'));
    });
  });
}

const address = value => value.trim().toLowerCase().includes(':') ? value.trim().toLowerCase() : value.trim().toLowerCase() + ':25565';
const matches = (message, markers) => markers.some(marker => message.startsWith(marker) || message.startsWith('[' + marker + ']'));

export function installServerLogin(bot, options) {
  let stage = 'disabled', attempted = false, active = true, account;
  const report = status => { stage = status; options.report?.({ status, username: options.username, server: options.server }); };
  try {
    if (options.configFile) {
      const contents = readFileSync(options.configFile, 'utf8');
      if (contents.length > 32768) throw new Error('configuration size');
      const config = JSON.parse(contents);
      if (config.enabled === true && Array.isArray(config.accounts)) {
        const accounts = config.accounts.filter(a => a && typeof a.server === 'string'
          && address(a.server) === address(options.server) && a.username === options.username);
        if (accounts.length > 1) throw new Error('duplicate accounts');
        account = accounts[0];
        if (account) {
          if (typeof account.credentialFile !== 'string' || !account.credentialFile || !/^[a-z][a-z0-9_]*$/.test(account.command)
            || ['requestMarkers', 'successMarkers', 'failureMarkers'].some(key => !Array.isArray(account[key])
              || account[key].length < 1 || account[key].length > 16 || account[key].some(m => typeof m !== 'string' || !m.trim() || m.length > 160))) throw new Error('incomplete account');
          report('armed');
        }
      }
    }
  } catch { account = undefined; report('blocked'); }
  const stop = () => { active = false; bot.off('message', onMessage); bot.off('end', stop); bot.off('kicked', stop); stage = 'closed'; };
  const onMessage = (message, position) => {
    if (!active || !account || !['armed', 'submitted'].includes(stage) || position !== 'system') return;
    const value = message.toString().replace(/§[0-9A-FK-OR]/gi, '').trimStart();
    if (matches(value, account.failureMarkers)) { report('blocked'); return; }
    if (matches(value, account.successMarkers)) { report('confirmed'); return; }
    if (attempted || !matches(value, account.requestMarkers)) return;
    attempted = true;
    const selected = account;
    void (options.readCredential ?? readProtectedCredential)(selected.credentialFile).then(bytes => {
      try {
        if (!active || stage !== 'armed') return;
        const password = bytes.toString('utf8');
        if (!password || password.length > 128 || /\s/.test(password)) throw new Error('invalid private credential');
        bot.chat('/' + selected.command + ' ' + password);
        report('submitted');
      } finally { bytes.fill(0); }
    }).catch(() => { if (active && stage === 'armed') report('blocked'); });
  };
  bot.on('message', onMessage);
  bot.once('end', stop);
  bot.once('kicked', stop);
  return { stop, status: () => ({ stage, attempted }) };
}
