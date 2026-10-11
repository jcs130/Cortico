/** Cormini's versioned procedural Memory and evidence-based adoption tools. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CoreApi, EventEnvelope, ToolCallContext, ToolDef } from 'cortico/core/types.ts';
import { parseProcedure, procedureHash, procedureId, procedureRevision, resolveProcedure,
  PROCEDURE_SCHEMA, PROCEDURE_RECEIPT_SCHEMA, PROCEDURE_RECEIPT_MIME, PROCEDURE_LIMITS,
  type ProcedureVersion, type ProcedureReceipt } from 'cortico/protocol/procedure.ts';
import type { GitWorkspaceMemory } from './memory.ts';

export const PROCEDURES_DIR = 'procedures/';
const INDEX = `${PROCEDURES_DIR}index.json`;
interface Entry {
  id: string; adapter: string; description: string; conditions: string[];
  head: string; adopted: string | null; review?: { id: string; revision: string; outcome: string };
}
interface Observation {
  executionId: string; revision: string; adapter: string; mode: ProcedureReceipt['mode']; status: ProcedureReceipt['status'];
  event: { source: string; type: string; run?: string; cursor: number; ts: string };
  receipt: string; receiptHash: string;
}
interface Review {
  id: string; revision: string; execution: Observation; outcome: 'achieved' | 'not-achieved' | 'unknown';
  assessment: string; context: string; measurements: Record<string, number | null>;
  comparison: string | null; author: ProcedureVersion['author']; createdAt: string;
}
export interface ProcedureMemoryOptions {
  memory: GitWorkspaceMemory;
  core(): CoreApi | null;
  guard(path: string, role: string): string | null;
}

export function managedProcedurePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  // Resolve '..' before calling this helper at the filesystem-tool boundary.
  return normalized === 'procedures' || normalized.startsWith(PROCEDURES_DIR);
}
function text(value: unknown, field: string, max = 1600): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} must contain 1–${max} characters`);
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new Error('invalid evidence/review id');
  return value;
}
const author = (ctx: ToolCallContext): ProcedureVersion['author'] => ({ kind: ctx.callId ? 'agent' : 'operator', role: ctx.role,
  ...(ctx.callId ? { callId: ctx.callId } : {}) });
const versionPath = (id: string, revision: string) => `${PROCEDURES_DIR}versions/${procedureId(id)}/${procedureRevision(revision)}.json`;
const reviewPath = (id: string, review: string) => `${PROCEDURES_DIR}reviews/${procedureId(id)}/${uuid(review)}.json`;
const evidencePath = (revision: string, execution: string) => `${PROCEDURES_DIR}evidence/${procedureRevision(revision)}/${uuid(execution)}.json`;

export class ProcedureMemory {
  constructor(private readonly options: ProcedureMemoryOptions) {}
  private get memory() { return this.options.memory; }
  private index(): Record<string, Entry> { return this.memory.exists(INDEX) ? JSON.parse(this.memory.readFile(INDEX)) : {}; }
  private write(path: string, value: unknown, role?: string): void {
    const denied = role && this.options.guard(path, role);
    if (denied) throw new Error(denied);
    this.memory.writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
  }
  private immutable(path: string, value: unknown, role?: string): void {
    if (this.memory.exists(path)) throw new Error(`immutable record already exists: ${path}`);
    this.write(path, value, role);
  }
  private version(id: string, revision: string): ProcedureVersion {
    return parseProcedure(JSON.parse(this.memory.readFile(versionPath(id, revision))));
  }
  private entry(id: unknown): Entry {
    const index = this.index(), key = procedureId(id);
    const result = Object.hasOwn(index, key) ? index[key] : undefined;
    if (!result) throw new Error('procedure is not in the library');
    return result;
  }

  /** Called on actual event delivery. The receipt stays in Core's immutable log blob store. */
  observe(event: EventEnvelope): void {
    const metadata = event.meta?.procedureReceipt as Partial<ProcedureReceipt> | undefined;
    if (metadata?.schema !== PROCEDURE_RECEIPT_SCHEMA || event.origin !== 'external') return;
    const blob = event.blobs?.find(b => b.mime === PROCEDURE_RECEIPT_MIME && b.handle.startsWith('log:'));
    const got = blob && this.options.core()?.blob(blob.handle);
    if (!got || got.bytes.byteLength > 2_000_000) return;
    const receipt = JSON.parse(new TextDecoder().decode(got.bytes)) as ProcedureReceipt;
    if (receipt.schema !== PROCEDURE_RECEIPT_SCHEMA || receipt.executionId !== metadata.executionId
      || receipt.root?.revision !== metadata.root?.revision || receipt.status !== metadata.status
      || !['validation', 'execution'].includes(receipt.mode)
      || !['validated', 'completed', 'failed', 'cancelled'].includes(receipt.status)) throw new Error('procedure event/receipt mismatch');
    const path = evidencePath(receipt.root.revision, receipt.executionId);
    if (this.memory.exists(path)) return;
    const observation: Observation = { executionId: receipt.executionId, revision: receipt.root.revision,
      adapter: receipt.adapter, mode: receipt.mode, status: receipt.status,
      event: { source: event.source, type: event.type, run: event.run, cursor: event.cursor, ts: event.ts },
      receipt: blob!.handle, receiptHash: createHash('sha256').update(got.bytes).digest('hex') };
    this.immutable(path, observation);
  }

  private find(args: Record<string, unknown>): unknown {
    if (args.id !== undefined) {
      const entry = this.entry(args.id);
      const revision = args.revision === undefined ? entry.adopted ?? entry.head : procedureRevision(args.revision);
      const version = this.version(entry.id, revision);
      if (args.review !== undefined) return JSON.parse(this.memory.readFile(reviewPath(entry.id, uuid(args.review))));
      if (args.execution !== undefined) {
        const observation = JSON.parse(this.memory.readFile(evidencePath(revision, uuid(args.execution)))) as Observation;
        const receipt = this.options.core()?.blob(observation.receipt);
        if (!receipt) return { observation, unverified: 'receipt blob unavailable' };
        if (createHash('sha256').update(receipt.bytes).digest('hex') !== observation.receiptHash) throw new Error('original receipt changed');
        const run = JSON.parse(new TextDecoder().decode(receipt.bytes)) as ProcedureReceipt;
        if (args.call !== undefined) {
          if (!Number.isInteger(args.call) || Number(args.call) < 1 || Number(args.call) > run.trace.length) throw new Error('call must select an existing 1-based adapter call');
          return { observation, call: args.call, trace: run.trace[Number(args.call) - 1] };
        }
        const result = JSON.stringify(run.result ?? null);
        return { observation, execution: { ...run,
          result: result.length > 2000 ? { excerpt: result.slice(0, 2000), truncated: true } : run.result,
          trace: run.trace.map((value, i) => {
            const trace = value as Record<string, unknown>;
            const reply = trace.result as Record<string, unknown> | undefined;
            return { call: i + 1, method: trace.method, startedAt: trace.startedAt, endedAt: trace.endedAt,
              error: trace.error, taskId: reply?.taskId, kind: reply?.kind, done: reply?.done };
          }) } };
      }
      const evidenceDir = `${PROCEDURES_DIR}evidence/${revision}`;
      return { entry, handle: `mem:${versionPath(entry.id, revision)}`, version,
        evidence: this.memory.exists(evidenceDir) ? this.memory.walkFiles(evidenceDir).filter(f => f.endsWith('.json')).slice(-8) : [] };
    }
    if (args.revision !== undefined || args.review !== undefined || args.execution !== undefined || args.call !== undefined) throw new Error('id is required for version/evidence/review lookup');
    const query = typeof args.query === 'string' ? args.query.toLowerCase().slice(0, 200) : '';
    const matches = Object.values(this.index()).filter(entry => (!args.adapter || entry.adapter === args.adapter)
      && (!query || `${entry.id} ${entry.description} ${entry.conditions.join(' ')}`.toLowerCase().includes(query)));
    return { total: matches.length, entries: matches.slice(0, 20), omitted: Math.max(0, matches.length - 20) };
  }

  private save(args: Record<string, unknown>, ctx: ToolCallContext): unknown {
    const id = procedureId(args.id), index = this.index();
    const previous = Object.hasOwn(index, id) ? index[id] : undefined;
    const base = args.base === null ? null : procedureRevision(args.base);
    if ((previous?.head ?? null) !== base) throw new Error(`procedure head changed; current head: ${previous?.head ?? 'null'}`);
    const code = text(args.code, 'code', PROCEDURE_LIMITS.sourceChars);
    const body = { schema: PROCEDURE_SCHEMA, id, adapter: args.adapter as string, description: args.description as string,
      conditions: args.conditions as string[], code, dependencies: args.dependencies ?? {}, parent: base,
      author: author(ctx), createdAt: new Date().toISOString(), sourceHash: createHash('sha256').update(code).digest('hex') };
    const version = parseProcedure({ ...body, revision: procedureHash(body) });
    if (previous && previous.adapter !== version.adapter) throw new Error('a procedure revision cannot change adapters; use another id');
    const path = versionPath(id, version.revision), handle = `mem:${path}`;
    resolveProcedure({ handle, revision: version.revision }, version.adapter, reference => reference === handle
      ? { bytes: new TextEncoder().encode(JSON.stringify(version)), mime: 'application/json' }
      : this.options.core()?.blob(reference) ?? this.memory.blobs.get(reference));
    const denied = this.options.guard(INDEX, ctx.role);
    if (denied) throw new Error(denied);
    this.immutable(path, version, ctx.role);
    index[id] = { id, adapter: version.adapter, description: version.description, conditions: version.conditions,
      head: version.revision, adopted: previous?.adopted ?? null, ...(previous?.review ? { review: previous.review } : {}) };
    this.write(INDEX, index, ctx.role);
    return { id, handle, revision: version.revision, sourceHash: version.sourceHash, parent: base,
      state: 'candidate', adopted: index[id].adopted, next: 'validate with the adapter; execute; inspect actual results; review before adoption' };
  }

  private review(args: Record<string, unknown>, ctx: ToolCallContext): Review {
    const entry = this.entry(args.id), revision = procedureRevision(args.revision);
    const version = this.version(entry.id, revision);
    const execution = JSON.parse(this.memory.readFile(evidencePath(revision, uuid(args.execution)))) as Observation;
    const got = this.options.core()?.blob(execution.receipt);
    if (!got || createHash('sha256').update(got.bytes).digest('hex') !== execution.receiptHash) throw new Error('original execution receipt unavailable or changed; review is unverified');
    if (execution.mode !== 'execution') throw new Error('syntax validation is not execution evidence');
    if (execution.adapter !== version.adapter || execution.revision !== version.revision) throw new Error('execution adapter/version mismatch');
    if (!['achieved', 'not-achieved', 'unknown'].includes(String(args.outcome))) throw new Error('invalid goal outcome');
    const measurements = args.measurements ?? {};
    if (!measurements || typeof measurements !== 'object' || Array.isArray(measurements) || Object.keys(measurements).length > 12
      || Object.entries(measurements).some(([key, value]) => key.length > 80 || (value !== null && (typeof value !== 'number' || !Number.isFinite(value))))) throw new Error('measurements must be at most twelve named finite numbers or null (include units in names)');
    const comparison = args.comparison === undefined ? null : uuid(args.comparison);
    if (comparison) JSON.parse(this.memory.readFile(reviewPath(entry.id, comparison)));
    const review: Review = { id: randomUUID(), revision, execution, outcome: args.outcome as Review['outcome'],
      assessment: text(args.assessment, 'assessment'), context: text(args.context, 'context'),
      measurements: measurements as Review['measurements'], comparison, author: author(ctx), createdAt: new Date().toISOString() };
    const denied = this.options.guard(INDEX, ctx.role);
    if (denied) throw new Error(denied);
    this.immutable(reviewPath(entry.id, review.id), review, ctx.role);
    const index = this.index();
    index[entry.id].review = { id: review.id, revision, outcome: review.outcome };
    this.write(INDEX, index, ctx.role);
    return review;
  }

  private adopt(args: Record<string, unknown>, ctx: ToolCallContext): unknown {
    const entry = this.entry(args.id), revision = procedureRevision(args.revision);
    const expected = args.expectedAdopted === null ? null : procedureRevision(args.expectedAdopted);
    if (entry.adopted !== expected) throw new Error(`adopted version changed; current: ${entry.adopted ?? 'null'}`);
    const version = this.version(entry.id, revision);
    const review = JSON.parse(this.memory.readFile(reviewPath(entry.id, uuid(args.review)))) as Review;
    if (review.revision !== revision || review.outcome !== 'achieved' || review.execution.mode !== 'execution'
      || review.execution.status !== 'completed') throw new Error('adoption requires this version\'s completed execution and an explicit achieved-goal assessment');
    const receipt = this.options.core()?.blob(review.execution.receipt);
    if (!receipt || createHash('sha256').update(receipt.bytes).digest('hex') !== review.execution.receiptHash) throw new Error('original execution receipt unavailable or changed; adoption is unverified');
    const reason = text(args.reason, 'reason', 800);
    const denied = this.options.guard(INDEX, ctx.role);
    if (denied) throw new Error(denied);
    const index = this.index();
    const journal = { id: randomUUID(), procedure: entry.id, previous: expected, revision, review: review.id,
      reason, author: author(ctx), createdAt: new Date().toISOString() };
    this.immutable(`${PROCEDURES_DIR}adoptions/${journal.id}.json`, journal, ctx.role);
    index[entry.id].adopted = version.revision;
    this.write(INDEX, index, ctx.role);
    return { ...journal, handle: `mem:${versionPath(entry.id, revision)}`,
      scope: 'preferred version for future explicit selection; no running program changed; assessment is agent-authored, not proof of general improvement' };
  }

  tools(): ToolDef[] {
    const property = (description: string) => ({ type: 'string', description });
    const wrap = (operation: (args: Record<string, unknown>, ctx: ToolCallContext) => unknown, prefix = ''): ToolDef['handler'] => async (args, ctx) => {
      try { return prefix + JSON.stringify(operation(args, ctx)); }
      catch (error) { return { text: String(error), failed: true }; }
    };
    const id = property('Procedure id; lowercase letters, digits and hyphens.'), revision = property('Exact revision SHA256 from procedure_save/find.');
    return [
      { name: 'procedure_help', tags: ['read'], description: 'Read the on-demand guide for composing, validating, reviewing and adopting executable methods across Worlds.',
        parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => readFileSync(new URL('./PROCEDURES.md', import.meta.url), 'utf8') },
      { name: 'procedure_find', tags: ['read'], description: 'Search compact method summaries by purpose/conditions/adapter. With id, read one adopted version (candidate head if none), its exact handle, and up to eight evidence paths. revision selects a candidate or older version; execution expands a delivered actual receipt, review reads an assessment. No library sources are injected automatically.',
        parameters: { type: 'object', properties: { query: property('Purpose or applicability keyword.'), adapter: property('Capability adapter filter.'),
          id, revision, execution: property('Execution UUID from the adapter event.'), review: property('Review UUID.'),
          call: { type: 'integer', minimum: 1, description: 'With execution, expand one adapter call instead of returning summaries.' } }, required: [] },
        handler: wrap(args => this.find(args)) },
      { name: 'procedure_save', tags: ['write'], description: 'Save an agent-authored executable candidate with immutable source/dependency hashes and parent provenance. base:null creates a method; otherwise base must equal its current candidate head. Does not execute or adopt. Use procedure_help for the composition contract.',
        parameters: { type: 'object', properties: { id, adapter: property('Versioned capability contract, e.g. minecraft-method/v1.'),
          description: property('Purpose, parameter meanings and returned result contract; at most 800 characters.'),
          conditions: { type: 'array', items: { type: 'string' }, maxItems: 8 }, code: property('JavaScript async function body. Explicitly check fresh preconditions and postconditions.'),
          dependencies: { type: 'object', additionalProperties: { type: 'object', properties: { handle: property('Exact mem:/log: artifact handle.'), revision }, required: ['handle', 'revision'] } },
          base: { type: ['string', 'null'], description: 'Current candidate head hash, or null for a new id.' } },
          required: ['id', 'adapter', 'description', 'conditions', 'code', 'base'] }, handler: wrap((args, ctx) => this.save(args, ctx), '[procedure saved] ') },
      { name: 'procedure_review', tags: ['write'], description: 'Record your goal assessment against a delivered actual execution receipt. Validation-only evidence is rejected. Keep failures, unknowns and counterexamples. Measurements/context/assessment are your interpretation; the original receipt and event remain separately attributable. comparison links an older review of this method.',
        parameters: { type: 'object', properties: { id, revision, execution: property('Actual execution UUID delivered by a World.'),
          outcome: { type: 'string', enum: ['achieved', 'not-achieved', 'unknown'] }, assessment: property('Explain observed before/after, failures, missing evidence and what to retain or revise.'),
          context: property('Test conditions, environment differences and applicability boundaries.'), measurements: { type: 'object', additionalProperties: { type: ['number', 'null'] } },
          comparison: property('Older review UUID for a comparable baseline; omit if none.') }, required: ['id', 'revision', 'execution', 'outcome', 'assessment', 'context'] },
        handler: wrap((args, ctx) => this.review(args, ctx), '[procedure reviewed] ') },
      { name: 'procedure_adopt', tags: ['write'], description: 'Select a reviewed version as preferred for future explicit runs. Requires its completed real execution and achieved-goal assessment. expectedAdopted prevents concurrent overwrites. Select an older reviewed revision to roll back; running actions are unaffected. This is procedural Memory, not model-weight training.',
        parameters: { type: 'object', properties: { id, revision, review: property('This version\'s achieved-goal review UUID.'),
          expectedAdopted: { type: ['string', 'null'], description: 'Current adopted hash, or null if none.' }, reason: property('Why this scoped evidence supports adoption or rollback.') },
          required: ['id', 'revision', 'review', 'expectedAdopted', 'reason'] }, handler: wrap((args, ctx) => this.adopt(args, ctx), '[procedure adopted] ') },
    ];
  }
}
