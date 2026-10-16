import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const { UsageLog } = await tsImport('./usage-log.ts', import.meta.url);
const { aggregateUsage } = await tsImport('./cost.ts', import.meta.url);
const log = new UsageLog(workerData.file, () => {});
const records = log.readAll();
const ids = new Set(records.map(record => record.recordId ?? record.attempt?.id));
for (const record of workerData.pending) {
  if (!ids.has(record.recordId)) {
    records.push(record);
    ids.add(record.recordId);
  }
}
parentPort.postMessage({
  count: records.length,
  aggregate: workerData.options ? aggregateUsage(records, workerData.options) : undefined,
  error: log.status().error,
});
