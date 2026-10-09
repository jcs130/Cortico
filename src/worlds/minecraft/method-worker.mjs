import { parentPort, workerData } from 'node:worker_threads';
import 'ses';

lockdown({ errorTaming: 'unsafe', consoleTaming: 'safe' });

let serial = 0;
const pending = new Map();
const rpc = harden((method, args = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ kind: 'call', id, method, args });
}));
parentPort.on('message', (message) => {
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(harden(message.value));
});

const mc = harden({
  state: () => rpc('state'),
  do: (steps) => rpc('do', { steps }),
  flightPlan: (args) => rpc('flightPlan', args),
});

try {
  const compartment = new Compartment({ mc, params: harden(workerData.params) });
  const program = compartment.evaluate(`(async () => {\n${workerData.code}\n})`);
  if (typeof program !== 'function') throw new Error('code必须是异步函数体');
  const result = workerData.validate ? { valid: true } : await program();
  parentPort.postMessage({ kind: 'done', value: result === undefined ? null : result });
} catch (error) {
  parentPort.postMessage({ kind: 'error', error: String(error).slice(0, 1600) });
}
