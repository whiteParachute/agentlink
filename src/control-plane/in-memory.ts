import { createHash, randomUUID } from 'node:crypto';
import type {
  DeviceRecord,
  Domain,
  JsonRecord,
  LeaseRecord,
  RunEventRecord,
  RunRecord,
  RunnerRecord,
  TaskRecord,
} from '../domain/entities.js';
import { decideRetry } from '../domain/retry.js';
import type { LeaseStatus, RunStatus } from '../domain/status.js';
import { isActiveLeaseStatus, isTerminalRunStatus } from '../domain/status.js';
import { AgentlinkError } from './errors.js';

export interface ControlPlaneOptions {
  now?: () => Date;
  leaseTtlMs?: number;
}

export interface CreateTaskInput {
  domain?: Domain;
  source: string;
  sourceRef: string;
  payload?: JsonRecord;
  taskSpec?: JsonRecord;
  maxRetries?: number;
}

export interface RegisterDeviceInput {
  domain?: Domain;
  displayName: string;
  ownerUserId: string;
  networkScope?: string;
  trustLevel?: DeviceRecord['trustLevel'];
  agentletVersion?: string;
  metadata?: JsonRecord;
  runner?: {
    runnerType?: string;
    runnerVersion?: string;
    model?: string;
    maxConcurrency?: number;
    capabilities?: readonly string[];
  };
}

export interface PullInput {
  deviceId: string;
  runnerId: string;
  supportedCapabilities?: readonly string[];
}

export interface AgentletInstruction {
  runId: string;
  taskId: string;
  leaseId: string;
  expiresAt: string;
  instruction: JsonRecord;
}

export interface CreateTaskResult {
  task: TaskRecord;
  run: RunRecord;
  created: boolean;
}

export interface RegisterDeviceResult {
  device: DeviceRecord;
  runner: RunnerRecord;
  deviceSecret: string;
}

interface IdempotencyEntry {
  taskId: string;
  signature: string;
}

export class InMemoryControlPlane {
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly runners = new Map<string, RunnerRecord>();
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly taskIdempotency = new Map<string, IdempotencyEntry>();
  private readonly events = new Map<string, Map<number, RunEventRecord>>();

  constructor(options: ControlPlaneOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 5 * 60 * 1000;
  }

  createTask(input: CreateTaskInput, idempotencyKey: string): CreateTaskResult {
    if (!idempotencyKey) {
      throw new AgentlinkError(400, 'AL_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    }
    const domain = input.domain ?? 'personal';
    const signature = stableStringify({ domain, input });
    const idempotencyMapKey = `${domain}:${idempotencyKey}`;
    const existing = this.taskIdempotency.get(idempotencyMapKey);
    if (existing) {
      if (existing.signature !== signature) {
        throw new AgentlinkError(409, 'AL_IDEMPOTENCY_CONFLICT', 'Idempotency-Key was reused with a different payload');
      }
      const task = this.mustGetTask(existing.taskId);
      return { task, run: this.mustGetRun(task.currentRunId), created: false };
    }

    const now = this.timestamp();
    const taskId = randomUUID();
    const runId = randomUUID();
    const instruction = this.buildDefaultInstruction(input);
    const task: TaskRecord = {
      id: taskId,
      domain,
      source: input.source,
      sourceRef: input.sourceRef,
      payload: input.payload ?? {},
      taskSpec: input.taskSpec ?? { route: { domain, device: 'claw-tenc', runner: 'codex' } },
      status: 'QUEUED',
      currentRunId: runId,
      retryCount: 0,
      maxRetries: input.maxRetries ?? 1,
      idempotencyKey,
      idempotencySignature: signature,
      createdAt: now,
      updatedAt: now,
    };
    const run: RunRecord = {
      id: runId,
      taskId,
      domain,
      status: 'QUEUED',
      attemptNo: 1,
      instruction,
      metrics: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
    this.runs.set(run.id, run);
    this.taskIdempotency.set(idempotencyMapKey, { taskId: task.id, signature });
    return { task, run, created: true };
  }

  registerDevice(input: RegisterDeviceInput): RegisterDeviceResult {
    const now = this.timestamp();
    const deviceSecret = `al_dev_${randomUUID().replaceAll('-', '')}`;
    const device: DeviceRecord = {
      id: randomUUID(),
      domain: input.domain ?? 'personal',
      displayName: input.displayName,
      tokenHash: hashSecret(deviceSecret),
      networkScope: input.networkScope ?? 'personal',
      ownerUserId: input.ownerUserId,
      trustLevel: input.trustLevel ?? 'standard',
      status: 'REGISTERED',
      ...(input.agentletVersion ? { agentletVersion: input.agentletVersion } : {}),
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const runnerInput = input.runner ?? {};
    const runner: RunnerRecord = {
      id: randomUUID(),
      deviceId: device.id,
      runnerType: runnerInput.runnerType ?? 'codex',
      ...(runnerInput.runnerVersion ? { runnerVersion: runnerInput.runnerVersion } : {}),
      ...(runnerInput.model ? { model: runnerInput.model } : {}),
      status: 'online',
      maxConcurrency: runnerInput.maxConcurrency ?? 1,
      capabilities: runnerInput.capabilities ?? ['codex:exec'],
      createdAt: now,
      updatedAt: now,
    };

    this.devices.set(device.id, device);
    this.runners.set(runner.id, runner);
    return { device, runner, deviceSecret };
  }

  heartbeat(deviceId: string, deviceSecret: string): DeviceRecord {
    const device = this.authenticateDevice(deviceId, deviceSecret);
    const now = this.timestamp();
    device.status = 'ONLINE';
    device.lastAuthAt = now;
    device.lastHeartbeatAt = now;
    device.updatedAt = now;
    return device;
  }

  pull(input: PullInput): AgentletInstruction | undefined {
    const device = this.mustGetDevice(input.deviceId);
    if (device.status !== 'ONLINE') {
      throw new AgentlinkError(503, 'AL_DEVICE_OFFLINE', 'Device must be ONLINE before pulling work');
    }
    const runner = this.mustGetRunner(input.runnerId);
    if (runner.deviceId !== device.id || runner.status !== 'online') {
      throw new AgentlinkError(403, 'AL_RUN_001', 'Runner is not available for this device');
    }

    const run = [...this.runs.values()].find((candidate) => {
      if (candidate.domain !== device.domain || candidate.status !== 'QUEUED') return false;
      if (this.findActiveLease(candidate.id)) return false;
      const required = getRequiredCapabilities(candidate.instruction);
      const supported = new Set(input.supportedCapabilities ?? runner.capabilities);
      return required.every((capability) => supported.has(capability));
    });
    if (!run) return undefined;

    const nowDate = this.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + this.leaseTtlMs).toISOString();
    const lease: LeaseRecord = {
      id: randomUUID(),
      runId: run.id,
      domain: run.domain,
      deviceId: device.id,
      runnerId: runner.id,
      status: 'ISSUED',
      issuedAt: now,
      expiresAt,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.leases.set(lease.id, lease);
    this.updateRun(run.id, { status: 'LEASED', currentLeaseId: lease.id, updatedAt: now });
    const task = this.mustGetTask(run.taskId);
    this.updateTask(task.id, { status: 'RUNNING', updatedAt: now });
    return { runId: run.id, taskId: run.taskId, leaseId: lease.id, expiresAt, instruction: run.instruction };
  }

  ackLease(leaseId: string, accepted: boolean, reason?: string): { lease: LeaseRecord; run: RunRecord; task: TaskRecord } {
    const lease = this.mustGetLease(leaseId);
    if (lease.status !== 'ISSUED') {
      throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Only ISSUED leases can be acknowledged');
    }
    const now = this.timestamp();
    if (!accepted) {
      lease.status = 'REJECTED';
      lease.updatedAt = now;
      lease.expireReason = reason ?? 'agentlet_rejected';
      const run = this.updateRun(lease.runId, { status: 'QUEUED', updatedAt: now });
      delete run.currentLeaseId;
      this.runs.set(run.id, run);
      const task = this.updateTask(run.taskId, { status: 'QUEUED', updatedAt: now });
      return { lease, run, task };
    }

    lease.status = 'ACKED';
    lease.ackedAt = now;
    lease.updatedAt = now;
    const run = this.updateRun(lease.runId, { status: 'RUNNING', startedAt: now, updatedAt: now });
    const task = this.mustGetTask(run.taskId);
    return { lease, run, task };
  }

  appendProgress(input: { runId: string; leaseId: string; seq: number; eventType: string; payload?: JsonRecord }): RunEventRecord {
    const run = this.mustGetRun(input.runId);
    this.mustHaveExecutingLease(run, input.leaseId);
    if (!Number.isInteger(input.seq) || input.seq <= 0) {
      throw new AgentlinkError(400, 'AL_EVENT_SEQ_INVALID', 'Progress seq must be a positive integer');
    }
    const perRunEvents = this.getEventMap(run.id);
    const payload = input.payload ?? {};
    const existing = perRunEvents.get(input.seq);
    if (existing) {
      if (stableStringify(existing.payload) !== stableStringify(payload) || existing.eventType !== input.eventType) {
        throw new AgentlinkError(409, 'AL_IDEMPOTENCY_CONFLICT', 'Progress seq was reused with different content');
      }
      return existing;
    }

    const event: RunEventRecord = {
      runId: run.id,
      seq: input.seq,
      domain: run.domain,
      eventType: input.eventType,
      payload,
      emittedAt: this.timestamp(),
    };
    perRunEvents.set(event.seq, event);
    return event;
  }

  completeRun(input: {
    runId: string;
    leaseId: string;
    status: Extract<RunStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;
    result?: JsonRecord;
    error?: JsonRecord;
    metrics?: JsonRecord;
  }): { run: RunRecord; task: TaskRecord; lease: LeaseRecord } {
    const run = this.mustGetRun(input.runId);
    const lease = this.mustGetLease(input.leaseId);
    const terminalPayloadHash = hashStable({ status: input.status, result: input.result, error: input.error, metrics: input.metrics });

    if (lease.runId === run.id && lease.terminalPayloadHash === terminalPayloadHash && isTerminalRunStatus(run.status)) {
      return { run, task: this.mustGetTask(run.taskId), lease };
    }
    this.mustHaveExecutingLease(run, input.leaseId);

    const now = this.timestamp();
    const leaseStatus: LeaseStatus = input.status === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED';
    lease.status = leaseStatus;
    lease.terminalPayloadHash = terminalPayloadHash;
    lease.updatedAt = now;
    if (leaseStatus === 'COMPLETED') lease.completedAt = now;
    if (leaseStatus === 'CANCELLED') lease.cancelledAt = now;

    const taskBeforeComplete = this.mustGetTask(run.taskId);
    const taskStatus = input.status === 'SUCCEEDED' ? 'SUCCEEDED' : input.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    const runPatch: Partial<RunRecord> = {
      status: input.status,
      metrics: input.metrics ?? run.metrics,
      finishedAt: now,
      updatedAt: now,
    };
    if (input.result) runPatch.result = input.result;
    if (input.error) runPatch.error = input.error;
    const updatedRun = this.updateRun(input.runId, runPatch);

    if (input.status === 'FAILED') {
      const retryDecision = decideRetry(
        'runner_failed',
        { retryCount: taskBeforeComplete.retryCount, currentAttemptNo: run.attemptNo },
        { maxRetries: taskBeforeComplete.maxRetries },
        { retryable: input.error?.retryable === true },
      );
      if (retryDecision.shouldRetry) {
        const nextRun = this.createRunAttempt(taskBeforeComplete, updatedRun, retryDecision.nextAttemptNo ?? run.attemptNo + 1, now);
        const task = this.updateTask(taskBeforeComplete.id, {
          status: 'QUEUED',
          currentRunId: nextRun.id,
          retryCount: retryDecision.nextRetryCount ?? taskBeforeComplete.retryCount + 1,
          updatedAt: now,
        });
        return { run: updatedRun, task, lease };
      }
    }

    const task = this.updateTask(updatedRun.taskId, { status: taskStatus, updatedAt: now });
    return { run: updatedRun, task, lease };
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  getLease(leaseId: string): LeaseRecord | undefined {
    return this.leases.get(leaseId);
  }

  getRunEvents(runId: string, afterSeq = 0): RunEventRecord[] {
    return [...this.getEventMap(runId).values()].filter((event) => event.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  }

  authenticateDevice(deviceId: string, deviceSecret: string): DeviceRecord {
    const device = this.mustGetDevice(deviceId);
    if (device.status === 'REVOKED') {
      throw new AgentlinkError(401, 'AL_TOKEN_REVOKED', 'Device token was revoked');
    }
    if (device.tokenHash !== hashSecret(deviceSecret)) {
      throw new AgentlinkError(401, 'AL_AUTH_INVALID', 'Invalid device token');
    }
    return device;
  }

  private buildDefaultInstruction(input: CreateTaskInput): JsonRecord {
    return {
      type: 'codex_session',
      prompt: typeof input.payload?.text === 'string' ? input.payload.text : '',
      requiredCapabilities: ['codex:exec'],
      workspace: '/data00/home/heyucong.bebop/self-codes/agentlink',
    };
  }

  private mustGetTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new AgentlinkError(404, 'AL_TASK_NOT_FOUND', 'Task not found');
    return task;
  }

  private mustGetRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new AgentlinkError(404, 'AL_RUN_NOT_FOUND', 'Run not found');
    return run;
  }

  private mustGetLease(leaseId: string): LeaseRecord {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new AgentlinkError(404, 'AL_LEASE_NOT_FOUND', 'Lease not found');
    return lease;
  }

  private mustGetDevice(deviceId: string): DeviceRecord {
    const device = this.devices.get(deviceId);
    if (!device) throw new AgentlinkError(404, 'AL_DEVICE_NOT_FOUND', 'Device not found');
    return device;
  }

  private mustGetRunner(runnerId: string): RunnerRecord {
    const runner = this.runners.get(runnerId);
    if (!runner) throw new AgentlinkError(404, 'AL_RUNNER_NOT_FOUND', 'Runner not found');
    return runner;
  }

  private findActiveLease(runId: string): LeaseRecord | undefined {
    return [...this.leases.values()].find((lease) => lease.runId === runId && isActiveLeaseStatus(lease.status));
  }

  private mustHaveActiveLease(run: RunRecord, leaseId: string): LeaseRecord {
    const lease = this.mustGetLease(leaseId);
    if (run.currentLeaseId !== lease.id || !isActiveLeaseStatus(lease.status)) {
      throw new AgentlinkError(409, 'AL_LEASE_EXPIRED', 'Lease is not active for this run');
    }
    return lease;
  }

  private mustHaveExecutingLease(run: RunRecord, leaseId: string): LeaseRecord {
    const lease = this.mustHaveActiveLease(run, leaseId);
    if (run.status !== 'RUNNING' || (lease.status !== 'ACKED' && lease.status !== 'RENEWED')) {
      throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Lease must be ACKED or RENEWED and Run must be RUNNING');
    }
    return lease;
  }

  private updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const previous = this.mustGetTask(taskId);
    const next = { ...previous, ...removeUndefined(patch) };
    this.tasks.set(taskId, next);
    return next;
  }

  private updateRun(runId: string, patch: Partial<RunRecord>): RunRecord {
    const previous = this.mustGetRun(runId);
    const next = { ...previous, ...removeUndefined(patch), version: previous.version + 1 };
    if ('currentLeaseId' in patch && patch.currentLeaseId === undefined) {
      delete next.currentLeaseId;
    }
    this.runs.set(runId, next);
    return next;
  }

  private createRunAttempt(task: TaskRecord, previousRun: RunRecord, attemptNo: number, now: string): RunRecord {
    const nextRun: RunRecord = {
      id: randomUUID(),
      taskId: task.id,
      domain: task.domain,
      status: 'QUEUED',
      attemptNo,
      instruction: previousRun.instruction,
      retryOfRunId: previousRun.id,
      metrics: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(nextRun.id, nextRun);
    return nextRun;
  }

  private getEventMap(runId: string): Map<number, RunEventRecord> {
    const existing = this.events.get(runId);
    if (existing) return existing;
    const created = new Map<number, RunEventRecord>();
    this.events.set(runId, created);
    return created;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function getRequiredCapabilities(instruction: JsonRecord): string[] {
  const value = instruction.requiredCapabilities;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : ['codex:exec'];
}

function hashSecret(secret: string): string {
  return hashStable({ secret });
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function removeUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
