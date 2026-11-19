import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

try {
  const { UsageLog } = await tsImport('./usage-log.ts', import.meta.url);
  const { aggregateUsage, usageRecordFilter } = await tsImport('./cost.ts', import.meta.url);
  const errors = [];
  const log = new UsageLog(workerData.file, error => errors.push(error));
  const options = { ...workerData.options, now: workerData.options.now ?? new Date() };
  const keep = usageRecordFilter(options);
  const records = await log.readAll(keep, true);
  const ids = new Set(records.map(record => record.recordId ?? record.attempt?.id));
  for (const record of workerData.pending) {
    if (!keep(record)) continue;
    const id = record.recordId ?? record.attempt?.id;
    if (id && ids.has(id)) continue;
    if (id) ids.add(id);
    records.push(record);
  }
  parentPort.postMessage({ aggregate: aggregateUsage(records, options), error: errors.at(-1) ?? null });
} catch (error) {
  parentPort.postMessage({ failure: String(error) });
} finally {
  parentPort.close();
}
