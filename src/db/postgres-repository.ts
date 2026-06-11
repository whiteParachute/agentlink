import { randomUUID } from 'node:crypto';
import { AgentlinkError } from '../control-plane/errors.js';
import type { CreateTaskInput } from '../control-plane/in-memory.js';
import type { Domain, JsonRecord, LeaseRecord, RunEventRecord, RunRecord, TaskRecord } from '../domain/entities.js';
import { decideRetry } from '../domain/retry.js';
import { hashStable, stableStringify } from '../domain/signature.js';
import type { RunStatus } from '../domain/status.js';
import { PostgreSqlStatements } from './postgres-statements.js';
import { withTransaction, type SqlClient, type SqlQueryResult } from './transaction.js';

export interface PostgreSqlRepositoryOptions {
  now?: () => Date;
  leaseTtlMs?: number;
}

export interface CreateTaskRepositoryResult {
  task: TaskRecord;
  run: RunRecord;
  created: boolean;
}

export interface LeaseNextQueuedRunInput {
  deviceId: string;
  runnerId: string;
  domain?: Domain;
  leaseId?: string;
}

export interface LeaseNextQueuedRunResult {
  lease: LeaseRecord;
  run: RunRecord;
  task: TaskRecord;
}

export interface CompleteRunInput {
  runId: string;
  leaseId: string;
  status: Extract<RunStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;
  result?: JsonRecord;
  error?: JsonRecord;
  metrics?: JsonRecord;
}

export interface CompleteRunResult {
  run: RunRecord;
  task: TaskRecord;
  lease: LeaseRecord;
  retryRun?: RunRecord;
}

export interface ExpireLeaseResult {
  run: RunRecord;
  task: TaskRecord;
  lease: LeaseRecord;
  retryRun?: RunRecord;
}

export class PostgreSqlRepository {
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;

  constructor(private readonly client: SqlClient, options: PostgreSqlRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 5 * 60 * 1000;
  }

  async createTaskWithInitialRun(input: CreateTaskInput, idempotencyKey: string): Promise<CreateTaskRepositoryResult> {
    if (!idempotencyKey) throw new AgentlinkError(400, 'AL_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    const domain = input.domain ?? 'personal';
    const signature = createTaskIdempotencySignature(domain, input);

    try {
      return await withTransaction(this.client, async (tx) => {
        const existing = await this.findTaskByIdempotencyKey(tx, domain, idempotencyKey);
        if (existing) {
          if (existing.task.idempotencySignature !== signature) {
            throw new AgentlinkError(409, 'AL_IDEMPOTENCY_CONFLICT', 'Idempotency-Key was reused with a different payload');
          }
          return { ...existing, created: false };
        }

        const now = this.timestamp();
        const taskSpec = input.taskSpec ?? { route: { domain, device: 'claw-tenc', runner: 'codex' } };
        const instruction = buildDefaultInstruction(input);
        const result = await tx.query<EnvelopeRow>(PostgreSqlStatements.createTaskWithInitialRun, [
          randomUUID(),
          domain,
          input.source,
          input.sourceRef,
          toJsonbParam(input.payload ?? {}),
          toJsonbParam(taskSpec),
          input.maxRetries ?? 1,
          idempotencyKey,
          signature,
          now,
          randomUUID(),
          toJsonbParam(instruction),
        ]);
        const row = requireSingleRow(result, 'AL_INTERNAL', 'Task creation returned no rows');
        return { task: mapTask(row.task), run: mapRun(row.run), created: true };
      });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findTaskByIdempotencyKey(this.client, domain, idempotencyKey);
      if (!existing) throw error;
      if (existing.task.idempotencySignature !== signature) {
        throw new AgentlinkError(409, 'AL_IDEMPOTENCY_CONFLICT', 'Idempotency-Key was reused with a different payload');
      }
      return { ...existing, created: false };
    }
  }

  async leaseNextQueuedRun(input: LeaseNextQueuedRunInput): Promise<LeaseNextQueuedRunResult | undefined> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + this.leaseTtlMs).toISOString();
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.leaseNextQueuedRun, [
      input.deviceId,
      input.runnerId,
      input.domain ?? 'personal',
      input.leaseId ?? randomUUID(),
      now,
      expiresAt,
    ]);
    if (result.rowCount === 0) return undefined;
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Lease query returned rowCount without a row');
    return { lease: mapLease(row.lease), run: mapRun(row.run), task: mapTask(row.task) };
  }

  async ackLeaseAccepted(leaseId: string, deviceId: string): Promise<LeaseNextQueuedRunResult> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.ackLeaseAccepted, [leaseId, deviceId, this.timestamp()]);
    if (result.rowCount === 0) throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Only ISSUED leases can be acknowledged');
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Ack accepted returned rowCount without a row');
    return { lease: mapLease(row.lease), run: mapRun(row.run), task: mapTask(row.task) };
  }

  async ackLeaseRejected(leaseId: string, deviceId: string, reason = 'agentlet_rejected'): Promise<LeaseNextQueuedRunResult> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.ackLeaseRejected, [leaseId, deviceId, reason, this.timestamp()]);
    if (result.rowCount === 0) throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Only ISSUED leases can be rejected');
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Ack rejected returned rowCount without a row');
    return { lease: mapLease(row.lease), run: mapRun(row.run), task: mapTask(row.task) };
  }

  async appendAgentletProgress(input: { runId: string; leaseId: string; seq: number; eventType: string; payload?: JsonRecord }): Promise<RunEventRecord> {
    if (!Number.isInteger(input.seq) || input.seq <= 0) {
      throw new AgentlinkError(400, 'AL_EVENT_SEQ_INVALID', 'Progress seq must be a positive integer');
    }
    const payload = input.payload ?? {};
    const inserted = await this.client.query<RunEventRow>(PostgreSqlStatements.appendAgentletProgress, [
      input.runId,
      input.leaseId,
      input.seq,
      input.eventType,
      toJsonbParam(payload),
      this.timestamp(),
    ]);
    if (inserted.rowCount > 0) return mapRunEvent(requireSingleRow(inserted, 'AL_INTERNAL', 'Progress insert returned rowCount without a row'));

    const existing = await this.client.query<RunEventRow>(PostgreSqlStatements.findAgentletProgressBySeq, [input.runId, input.seq, input.leaseId]);
    if (existing.rowCount > 0) {
      const event = mapRunEvent(requireSingleRow(existing, 'AL_INTERNAL', 'Progress replay lookup returned rowCount without a row'));
      if (event.eventType === input.eventType && stableStringify(event.payload) === stableStringify(payload)) return event;
      throw new AgentlinkError(409, 'AL_IDEMPOTENCY_CONFLICT', 'Progress seq was reused with different content');
    }

    throw new AgentlinkError(409, 'AL_LEASE_EXPIRED', 'Lease is not active for this run');
  }

  async completeRun(input: CompleteRunInput): Promise<CompleteRunResult> {
    const terminalPayloadHash = hashStable({ status: input.status, result: input.result, error: input.error, metrics: input.metrics });
    return await withTransaction(this.client, async (tx) => {
      const completed = await tx.query<EnvelopeRow>(PostgreSqlStatements.completeRun, [
        input.runId,
        input.leaseId,
        input.status,
        toNullableJsonbParam(input.result),
        toNullableJsonbParam(input.error),
        toNullableJsonbParam(input.metrics),
        terminalPayloadHash,
        this.timestamp(),
      ]);

      if (completed.rowCount === 0) {
        const replay = await tx.query<EnvelopeRow>(PostgreSqlStatements.replayTerminalComplete, [input.runId, input.leaseId, terminalPayloadHash]);
        if (replay.rowCount > 0) {
          const row = requireSingleRow(replay, 'AL_INTERNAL', 'Terminal replay returned rowCount without a row');
          return { run: mapRun(row.run), task: mapTask(row.task), lease: mapLease(row.lease) };
        }
        const terminal = await tx.query<EnvelopeRow>(PostgreSqlStatements.findTerminalCompleteByRunLease, [input.runId, input.leaseId]);
        if (terminal.rowCount > 0) throw new AgentlinkError(409, 'AL_IDEMPOTENCY_CONFLICT', 'Terminal complete payload differs from the stored terminal payload');
        throw new AgentlinkError(409, 'AL_LEASE_EXPIRED', 'Lease is not active for this run');
      }

      const row = requireSingleRow(completed, 'AL_INTERNAL', 'Complete returned rowCount without a row');
      const baseResult: CompleteRunResult = { run: mapRun(row.run), task: mapTask(row.task), lease: mapLease(row.lease) };
      if (input.status !== 'FAILED') return baseResult;

      const retryDecision = decideRetry(
        'runner_failed',
        { retryCount: baseResult.task.retryCount, currentAttemptNo: baseResult.run.attemptNo },
        { maxRetries: baseResult.task.maxRetries },
        { retryable: input.error?.retryable === true },
      );
      if (!retryDecision.shouldRetry) return baseResult;

      const retry = await this.createRetryRunAttemptInTransaction(tx, input.runId, this.timestamp());
      return retry ? { ...baseResult, task: retry.task, retryRun: retry.run } : baseResult;
    });
  }

  async createRetryRunAttempt(previousRunId: string): Promise<{ run: RunRecord; task: TaskRecord } | undefined> {
    return await this.createRetryRunAttemptInTransaction(this.client, previousRunId, this.timestamp());
  }

  async expireActiveLease(leaseId: string, reason = 'lease_expired'): Promise<ExpireLeaseResult> {
    return await withTransaction(this.client, async (tx) => {
      const expired = await tx.query<EnvelopeRow>(PostgreSqlStatements.expireActiveLease, [leaseId, this.timestamp(), reason]);
      if (expired.rowCount === 0) throw new AgentlinkError(409, 'AL_LEASE_EXPIRED', 'Lease is not active or has not expired');
      const row = requireSingleRow(expired, 'AL_INTERNAL', 'Expire returned rowCount without a row');
      const baseResult: ExpireLeaseResult = { lease: mapLease(row.lease), run: mapRun(row.run), task: mapTask(row.task) };
      const retryDecision = decideRetry(
        'lease_expired',
        { retryCount: baseResult.task.retryCount, currentAttemptNo: baseResult.run.attemptNo },
        { maxRetries: baseResult.task.maxRetries },
      );
      if (!retryDecision.shouldRetry) return baseResult;
      const retry = await this.createRetryRunAttemptInTransaction(tx, baseResult.run.id, this.timestamp());
      return retry ? { ...baseResult, task: retry.task, retryRun: retry.run } : baseResult;
    });
  }

  async cancelTask(taskId: string, reason = 'user_cancelled'): Promise<{ task: TaskRecord; run?: RunRecord; lease?: LeaseRecord }> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.cancelTask, [taskId, this.timestamp(), reason]);
    if (result.rowCount === 0) throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Task cannot be cancelled');
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Cancel returned rowCount without a row');
    const mapped: { task: TaskRecord; run?: RunRecord; lease?: LeaseRecord } = { task: mapTask(row.task) };
    if (row.run) mapped.run = mapRun(row.run);
    if (row.lease) mapped.lease = mapLease(row.lease);
    return mapped;
  }

  private async createRetryRunAttemptInTransaction(client: SqlClient, previousRunId: string, now: string): Promise<{ run: RunRecord; task: TaskRecord } | undefined> {
    try {
      const result = await client.query<EnvelopeRow>(PostgreSqlStatements.createRetryRunAttempt, [previousRunId, randomUUID(), now]);
      if (result.rowCount === 0) return undefined;
      const row = requireSingleRow(result, 'AL_INTERNAL', 'Retry attempt returned rowCount without a row');
      return { run: mapRun(row.run), task: mapTask(row.task) };
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Retry attempt already exists for this task attempt');
      throw error;
    }
  }

  private async findTaskByIdempotencyKey(client: SqlClient, domain: Domain, idempotencyKey: string): Promise<{ task: TaskRecord; run: RunRecord } | undefined> {
    const result = await client.query<EnvelopeRow>(PostgreSqlStatements.findTaskByIdempotencyKey, [domain, idempotencyKey]);
    if (result.rowCount === 0) return undefined;
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Idempotency lookup returned rowCount without a row');
    return { task: mapTask(row.task), run: mapRun(row.run) };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function createTaskIdempotencySignature(domain: Domain, input: CreateTaskInput): string {
  return stableStringify({ domain, input });
}

interface EnvelopeRow {
  task?: unknown;
  run?: unknown;
  lease?: unknown;
}

type RunEventRow = Record<string, unknown>;

function buildDefaultInstruction(input: CreateTaskInput): JsonRecord {
  const taskSpec = input.taskSpec ?? {};
  return {
    type: 'codex_session',
    prompt: typeof input.payload?.text === 'string' ? input.payload.text : '',
    requiredCapabilities: getTaskSpecStringArray(taskSpec, 'requiredCapabilities') ?? getTaskSpecStringArray(taskSpec, 'required_capabilities') ?? ['codex:exec'],
    workspace: getTaskSpecString(taskSpec, 'workspace') ?? getTaskSpecString(taskSpec, 'workdir') ?? DEFAULT_WORKSPACE,
    networkScope: getTaskSpecString(taskSpec, 'networkScope') ?? getTaskSpecString(taskSpec, 'network_scope') ?? input.domain ?? 'personal',
    workdirAccess: getTaskSpecWorkdirAccess(taskSpec) ?? 'read_write',
  };
}

function toJsonbParam(value: JsonRecord): string {
  return JSON.stringify(value);
}

function toNullableJsonbParam(value: JsonRecord | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function requireSingleRow<Row>(result: SqlQueryResult<Row>, code: string, message: string): Row {
  const row = result.rows[0];
  if (!row) throw new AgentlinkError(500, code, message);
  return row;
}

function mapTask(value: unknown): TaskRecord {
  const row = asRecord(value, 'task');
  return {
    id: readString(row, 'id'),
    domain: readDomain(row, 'domain'),
    source: readString(row, 'source'),
    sourceRef: readString(row, 'source_ref'),
    payload: readJsonRecord(row, 'payload'),
    taskSpec: readJsonRecord(row, 'task_spec'),
    status: readString(row, 'status') as TaskRecord['status'],
    currentRunId: readString(row, 'current_run_id'),
    retryCount: readNumber(row, 'retry_count'),
    maxRetries: readNumber(row, 'max_retries'),
    idempotencyKey: readString(row, 'idempotency_key'),
    idempotencySignature: readString(row, 'idempotency_signature'),
    createdAt: readTimestamp(row, 'created_at'),
    updatedAt: readTimestamp(row, 'updated_at'),
  };
}

function mapRun(value: unknown): RunRecord {
  const row = asRecord(value, 'run');
  const record: RunRecord = {
    id: readString(row, 'id'),
    taskId: readString(row, 'task_id'),
    domain: readDomain(row, 'domain'),
    status: readString(row, 'status') as RunRecord['status'],
    attemptNo: readNumber(row, 'attempt_no'),
    instruction: readJsonRecord(row, 'instruction'),
    metrics: readJsonRecord(row, 'metrics'),
    version: readNumber(row, 'version'),
    createdAt: readTimestamp(row, 'created_at'),
    updatedAt: readTimestamp(row, 'updated_at'),
  };
  setOptionalString(record, 'retryOfRunId', row.retry_of_run_id);
  setOptionalString(record, 'currentLeaseId', row.current_lease_id);
  setOptionalString(record, 'policyDecisionId', row.policy_decision_id);
  setOptionalRecord(record, 'result', row.result);
  setOptionalRecord(record, 'error', row.error);
  setOptionalTimestamp(record, 'startedAt', row.started_at);
  setOptionalTimestamp(record, 'finishedAt', row.finished_at);
  setOptionalTimestamp(record, 'deadlineAt', row.deadline_at);
  return record;
}

function mapLease(value: unknown): LeaseRecord {
  const row = asRecord(value, 'lease');
  const record: LeaseRecord = {
    id: readString(row, 'id'),
    runId: readString(row, 'run_id'),
    domain: readDomain(row, 'domain'),
    deviceId: readString(row, 'device_id'),
    runnerId: readString(row, 'runner_id'),
    status: readString(row, 'status') as LeaseRecord['status'],
    issuedAt: readTimestamp(row, 'issued_at'),
    expiresAt: readTimestamp(row, 'expires_at'),
    version: readNumber(row, 'version'),
    createdAt: readTimestamp(row, 'created_at'),
    updatedAt: readTimestamp(row, 'updated_at'),
  };
  setOptionalTimestamp(record, 'ackedAt', row.acked_at);
  setOptionalTimestamp(record, 'renewedAt', row.renewed_at);
  setOptionalTimestamp(record, 'completedAt', row.completed_at);
  setOptionalTimestamp(record, 'cancelledAt', row.cancelled_at);
  setOptionalString(record, 'expireReason', row.expire_reason);
  setOptionalString(record, 'terminalPayloadHash', row.terminal_payload_hash);
  return record;
}

function mapRunEvent(value: unknown): RunEventRecord {
  const row = asRecord(value, 'event');
  return {
    runId: readString(row, 'run_id'),
    seq: readNumber(row, 'seq'),
    domain: readDomain(row, 'domain'),
    eventType: readString(row, 'event_type'),
    payload: readJsonRecord(row, 'payload'),
    emittedAt: readTimestamp(row, 'emitted_at'),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${label} row is not an object`);
  return value as Record<string, unknown>;
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${key} must be a string`);
  return value;
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${key} must be a number`);
}

function readTimestamp(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${key} must be a timestamp`);
}

function readDomain(row: Record<string, unknown>, key: string): Domain {
  const value = readString(row, key);
  if (value !== 'personal' && value !== 'work') throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${key} must be a domain`);
  return value;
}

function readJsonRecord(row: Record<string, unknown>, key: string): JsonRecord {
  const value = row[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${key} must be a JSON object`);
  return value as JsonRecord;
}

function setOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string') throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${String(key)} must be a string`);
  Object.assign(target, { [key]: value });
}

function setOptionalTimestamp<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  if (value === null || value === undefined) return;
  if (value instanceof Date) {
    Object.assign(target, { [key]: value.toISOString() });
    return;
  }
  if (typeof value !== 'string') throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${String(key)} must be a timestamp`);
  Object.assign(target, { [key]: value });
}

function setOptionalRecord<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  if (value === null || value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${String(key)} must be a JSON object`);
  Object.assign(target, { [key]: value });
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '23505');
}

function getTaskSpecString(taskSpec: JsonRecord, key: string): string | undefined {
  const value = taskSpec[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getTaskSpecStringArray(taskSpec: JsonRecord, key: string): string[] | undefined {
  const value = taskSpec[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function getTaskSpecWorkdirAccess(taskSpec: JsonRecord): 'read' | 'write' | 'read_write' | undefined {
  const value = taskSpec.workdirAccess ?? taskSpec.workdir_access ?? taskSpec.access_mode;
  return value === 'read' || value === 'write' || value === 'read_write' ? value : undefined;
}

const DEFAULT_WORKSPACE = process.env.AGENTLINK_DEFAULT_WORKSPACE ?? process.cwd();
