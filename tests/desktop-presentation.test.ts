import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { DesktopPresentation } from '../src/desktop-presentation.ts';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });
async function endpoint() {
  const commands: Record<string, any>[] = [];
  const state = { protocol: 'desktop-presentation/v1', ready: true, revision: 4, busy: false, foreground: null as string | null,
    recent: [] as Record<string, any>[], vocabulary: [
      { id: 'happy', kind: 'expression', about: { en: 'Happy' }, seconds: 2 },
      { id: 'wave', kind: 'motion', about: { en: 'Wave' }, seconds: 2 },
    ] };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify(state)); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const command = JSON.parse(body); commands.push(command);
    if (command.action === 'say') {
      state.busy = true; state.foreground = 'caption-1';
      state.recent.push({ id: 'caption-1', status: 'queued', source: command.source });
      res.end(JSON.stringify({ accepted: true, status: 'queued', id: 'caption-1', audio: false }));
    } else res.end(JSON.stringify({ accepted: true, id: command.id, audio: false }));
  });
  servers.push(server); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  const bridge = new DesktopPresentation(() => ({ mode: 'desktop-text', url }), new AbortController().signal);
  return { bridge, state, commands };
}
it('presents dialogue and host-selected installed actions without a speech backend', async () => {
  const { bridge, commands } = await endpoint();
  expect(await bridge.refresh()).toMatchObject({ textReady: true, voice: { configured: false }, audioOwner: false });
  const receipt = await bridge.speak({ action: 'speak', text: '[warm] 到村庄了。', evidence: [42], ifIdleRevision: 4 }, 'call-1');
  expect(receipt).toMatchObject({ accepted: true, status: 'queued', audio: false });
  expect(commands[0]).toMatchObject({ protocol: 'desktop-presentation/v1', action: 'say', text: '到村庄了。', evidence: [42], ifIdleRevision: 4 });
  expect(bridge.scene().activeAvatar?.capabilities.animationCatalog?.[0].bodyClip).toBe('wave');
  await bridge.attach({ audioActionId: 'caption-1', bodyClip: 'wave', expressionWeights: { happy: .7 } });
  expect(commands[1]).toMatchObject({ action: 'act', id: 'caption-1', actions: ['happy', 'wave'] });
  const status = await bridge.speak({ action: 'status' }, 'status');
  expect(status).toMatchObject({ audio: false, output: 'desktop-text' });
  expect(await bridge.speak({ action: 'select', voice: 'some-voice' }, 'select')).toMatchObject({ accepted: false });
  await bridge.stop();
  expect(commands[2]).toMatchObject({ action: 'cancel', id: 'caption-1' });
});
it('does not attach a late gesture after its displayed line has ended', async () => {
  const { bridge, commands, state } = await endpoint();
  await bridge.refresh(); state.foreground = null;
  expect(await bridge.attach({ audioActionId: 'old-caption', bodyClip: 'wave' })).toMatchObject({ accepted: false });
  expect(commands).toHaveLength(0);
});
it('routes authored text while reporting unavailable optional cues', async () => {
  const {bridge, commands} = await endpoint();
  await bridge.speak({action:'speak', text:'Hello.', performance:{emotion:'pleased',expression:'happy',bodyClip:'wave'}}, 'one-performance');
  expect(commands[0]).toMatchObject({action:'say',text:'Hello.',actions:['happy','wave']});
  const receipt = await bridge.speak({action:'speak',text:'Still valid.',performance:{bodyClip:'unknown'}}, 'missing');
  expect(receipt).toMatchObject({accepted:true,requestedPerformance:{bodyClip:'unknown'},presentationWarnings:[expect.any(String)]});
  expect(commands[1]).toMatchObject({action:'say',text:'Still valid.'});
  expect(commands[1].actions).toBeUndefined();
});
it('rejects public endpoints instead of falling back to TTS', async () => {
  const bridge = new DesktopPresentation(() => ({ mode: 'desktop-text', url: 'https://example.com' }), new AbortController().signal);
  await expect(bridge.refresh()).rejects.toThrow('loopback');
  const { bridge: running } = await endpoint();
  expect(running.enabled()).toBe(true);
});
