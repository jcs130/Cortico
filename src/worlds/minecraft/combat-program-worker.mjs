import { parentPort, workerData } from 'node:worker_threads';
import 'ses';

lockdown({ errorTaming: 'unsafe', consoleTaming: 'safe' });
try {
  const source = `(frame, params) => {\n${workerData.code}\n}`;
  new Compartment().evaluate(source);
  parentPort.on('message', ({ frame, params }) => {
    try {
      const result = new Compartment().evaluate(source)(harden(frame), harden(params));
      if (result && typeof result.then === 'function') throw new Error('Combat program must be synchronous');
      const text = JSON.stringify(result);
      if (!text || text.length > workerData.outputChars) throw new Error('Combat program output exceeds budget');
      parentPort.postMessage({ kind: 'result', value: JSON.parse(text) });
    } catch (error) { parentPort.postMessage({ kind: 'error', error: String(error).slice(0, 1600) }); }
  });
  parentPort.postMessage({ kind: 'ready' });
} catch (error) { parentPort.postMessage({ kind: 'error', error: String(error).slice(0, 1600) }); }
