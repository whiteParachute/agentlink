import { randomUUID } from 'node:crypto';
import type {
  CapabilityGrantRecord,
  ControlActionRecord,
  DeviceRecord,
  Domain,
  JsonRecord,
  LeaseRecord,
  MainUserRecord,
  PolicyDecisionRecord,
  RecoverDecision,
  RecoverableRunRecord,
  RunEventRecord,
  RunRecord,
  RunnerRecord,
  TaskRecord,
  WorkdirAccessMode,
  WorkdirGrantRecord,
} from '../domain/entities.js';
import { evaluateDispatchPolicy } from '../domain/policy.js';
import {
  EVENT_RETENTION_DEFAULTS,
  MAIN_USER_RETENTION_DEFAULTS,
  TASK_RETENTION_DEFAULTS,
  normalizeRetentionMetadata,
  withoutRawRetention,
  type RetentionMetadata,
  type RetentionMetadataInput,
} from '../domain/retention.js';
import { decideRetry } from '../domain/retry.js';
import { hashStable, stableStringify } from '../domain/signature.js';
import type { LeaseStatus, RunStatus } from '../domain/status.js';
import { isActiveLeaseStatus, isTerminalRunStatus } from '../domain/status.js';
import { AgentlinkError } from './errors.js';

export interface ControlPlaneOptions {
  now?: () => Date;
  leaseTtlMs?: number;
  defaultWorkspace?: string;
}

export interface CreateTaskInput {
  domain?: Domain;
  source: string;
  sourceRef: string;
  payload?: JsonRecord;
  taskSpec?: JsonRecord;
  maxRetries?: number;
  retention?: RetentionMetadataInput;
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
  capabilityGrants?: readonly string[];
  workdirGrants?: readonly {
    pathPrefix: string;
    accessMode?: WorkdirAccessMode;
  }[];
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
  private readonly defaultWorkspace: string;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly runners = new Map<string, RunnerRecord>();
  private readonly capabilityGrants = new Map<string, CapabilityGrantRecord>();
  private readonly workdirGrants = new Map<string, WorkdirGrantRecord>();
  private readonly policyDecisions = new Map<string, PolicyDecisionRecord>();
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly controlActions = new Map<string, ControlActionRecord>();
  private readonly taskIdempotency = new Map<string, IdempotencyEntry>();
  private readonly events = new Map<string, Map<number, RunEventRecord>>();
  private mainUser: MainUserRecord | undefined;

  constructor(options: ControlPlaneOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 5 * 60 * 1000;
    this.defaultWorkspace = options.defaultWorkspace ?? DEFAULT_WORKSPACE;
  }

  createTask(input: CreateTaskInput, idempotencyKey: string): CreateTaskResult {
    if (!idempotencyKey) {
      throw new AgentlinkError(400, 'AL_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    }
    const retention = normalizeRetentionMetadata(input.retention, TASK_RETENTION_DEFAULTS);
    const domain = input.domain ?? 'personal';
    const signature = stableStringify({ domain, input: withoutRawRetention(input), retention });
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
      retentionClass: retention.retentionClass,
      memorySpace: retention.memorySpace,
      sourceSystem: retention.sourceSystem,
      sensitivity: retention.sensitivity,
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
      retentionClass: retention.retentionClass,
      memorySpace: retention.memorySpace,
      sourceSystem: retention.sourceSystem,
      sensitivity: retention.sensitivity,
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

    for (const capability of input.capabilityGrants ?? []) {
      if (!runner.capabilities.includes(capability)) {
        throw new AgentlinkError(403, 'AL_CAPABILITY_DENIED', 'Capability must be declared before it can be granted');
      }
    }
    for (const grant of input.workdirGrants ?? []) {
      if (!grant.pathPrefix.startsWith('/')) {
        throw new AgentlinkError(403, 'AL_WORKDIR_DENIED', 'Workdir grant path_prefix must be absolute');
      }
    }

    this.devices.set(device.id, device);
    this.runners.set(runner.id, runner);
    for (const capability of input.capabilityGrants ?? []) {
      this.grantCapability({ domain: device.domain, deviceId: device.id, runnerId: runner.id, capability, grantedBy: 'device_register' });
    }
    for (const grant of input.workdirGrants ?? []) {
      this.grantWorkdir({ domain: device.domain, deviceId: device.id, pathPrefix: grant.pathPrefix, accessMode: grant.accessMode ?? 'read_write' });
    }
    return { device, runner, deviceSecret };
  }

  grantCapability(input: {
    domain?: Domain;
    deviceId: string;
    runnerId: string;
    capability: string;
    grantedBy: string;
  }): CapabilityGrantRecord {
    const now = this.timestamp();
    const device = this.mustGetDevice(input.deviceId);
    if (device.status === 'REVOKED') {
      throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Cannot grant capabilities to a revoked device');
    }
    if (input.domain && input.domain !== device.domain) {
      throw new AgentlinkError(403, 'AL_POLICY_DENIED', 'Grant domain must match device domain');
    }
    const runner = this.mustGetRunner(input.runnerId);
    if (runner.deviceId !== device.id) {
      throw new AgentlinkError(403, 'AL_POLICY_DENIED', 'Runner does not belong to device');
    }
    if (!runner.capabilities.includes(input.capability)) {
      throw new AgentlinkError(403, 'AL_CAPABILITY_DENIED', 'Capability must be declared before it can be granted');
    }
    const existing = [...this.capabilityGrants.values()].find(
      (grant) =>
        grant.domain === device.domain &&
        grant.deviceId === device.id &&
        grant.runnerId === runner.id &&
        grant.capability === input.capability &&
        grant.grantStatus === 'GRANTED' &&
        !grant.revokedAt,
    );
    if (existing) return existing;
    const grant: CapabilityGrantRecord = {
      id: randomUUID(),
      domain: device.domain,
      deviceId: device.id,
      runnerId: runner.id,
      capability: input.capability,
      grantStatus: 'GRANTED',
      grantedBy: input.grantedBy,
      grantedAt: now,
    };
    this.capabilityGrants.set(grant.id, grant);
    return grant;
  }

  listCapabilityGrants(deviceId: string): CapabilityGrantRecord[] {
    this.mustGetDevice(deviceId);
    return [...this.capabilityGrants.values()]
      .filter((grant) => grant.deviceId === deviceId)
      .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt) || a.id.localeCompare(b.id));
  }

  revokeCapabilityGrant(grantId: string): CapabilityGrantRecord {
    const grant = this.capabilityGrants.get(grantId);
    if (!grant) throw new AgentlinkError(404, 'AL_CAPABILITY_GRANT_NOT_FOUND', 'Capability grant not found');
    if (grant.grantStatus === 'REVOKED' && grant.revokedAt) return grant;
    const revoked: CapabilityGrantRecord = {
      ...grant,
      grantStatus: 'REVOKED',
      revokedAt: this.timestamp(),
    };
    this.capabilityGrants.set(grant.id, revoked);
    return revoked;
  }

  grantWorkdir(input: {
    domain?: Domain;
    deviceId: string;
    pathPrefix: string;
    accessMode?: WorkdirAccessMode;
  }): WorkdirGrantRecord {
    const now = this.timestamp();
    const device = this.mustGetDevice(input.deviceId);
    if (device.status === 'REVOKED') {
      throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Cannot grant workdirs to a revoked device');
    }
    if (input.domain && input.domain !== device.domain) {
      throw new AgentlinkError(403, 'AL_POLICY_DENIED', 'Grant domain must match device domain');
    }
    if (!input.pathPrefix.startsWith('/')) {
      throw new AgentlinkError(403, 'AL_WORKDIR_DENIED', 'Workdir grant path_prefix must be absolute');
    }
    const accessMode = input.accessMode ?? 'read_write';
    const existing = [...this.workdirGrants.values()].find(
      (grant) =>
        grant.domain === device.domain &&
        grant.deviceId === device.id &&
        grant.pathPrefix === input.pathPrefix &&
        grant.accessMode === accessMode &&
        !grant.revokedAt,
    );
    if (existing) return existing;
    const grant: WorkdirGrantRecord = {
      id: randomUUID(),
      domain: device.domain,
      deviceId: device.id,
      pathPrefix: input.pathPrefix,
      accessMode,
      createdAt: now,
    };
    this.workdirGrants.set(grant.id, grant);
    return grant;
  }

  listWorkdirGrants(deviceId: string): WorkdirGrantRecord[] {
    this.mustGetDevice(deviceId);
    return [...this.workdirGrants.values()]
      .filter((grant) => grant.deviceId === deviceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  revokeWorkdirGrant(grantId: string): WorkdirGrantRecord {
    const grant = this.workdirGrants.get(grantId);
    if (!grant) throw new AgentlinkError(404, 'AL_WORKDIR_GRANT_NOT_FOUND', 'Workdir grant not found');
    if (grant.revokedAt) return grant;
    const revoked: WorkdirGrantRecord = {
      ...grant,
      revokedAt: this.timestamp(),
    };
    this.workdirGrants.set(grant.id, revoked);
    return revoked;
  }

  getMainUserProfile(): MainUserRecord | undefined {
    return this.mainUser;
  }

  upsertMainUserProfile(input: {
    displayName?: string;
    locale?: string;
    timezone?: string;
    metadata?: JsonRecord;
    retention?: RetentionMetadataInput;
  }): { mainUser: MainUserRecord; created: boolean } {
    const retention = normalizeRetentionMetadata(input.retention, MAIN_USER_RETENTION_DEFAULTS);
    const now = this.timestamp();
    const existing = this.mainUser;

    if (!existing) {
      const created: MainUserRecord = {
        id: 'main',
        displayName: input.displayName ?? 'Main User',
        locale: input.locale ?? 'zh-CN',
        timezone: input.timezone ?? 'Asia/Shanghai',
        metadata: input.metadata ?? {},
        retentionClass: retention.retentionClass,
        memorySpace: retention.memorySpace,
        sourceSystem: retention.sourceSystem,
        sensitivity: retention.sensitivity,
        createdAt: now,
        updatedAt: now,
      };
      this.mainUser = created;
      return { mainUser: created, created: true };
    }

    const updated: MainUserRecord = {
      ...existing,
      displayName: input.displayName ?? existing.displayName,
      locale: input.locale ?? existing.locale,
      timezone: input.timezone ?? existing.timezone,
      metadata: input.metadata ?? existing.metadata,
      retentionClass: retention.retentionClass,
      memorySpace: retention.memorySpace,
      sourceSystem: retention.sourceSystem,
      sensitivity: retention.sensitivity,
      updatedAt: now,
    };
    this.mainUser = updated;
    return { mainUser: updated, created: false };
  }

  revokeDevice(deviceId: string, reason = 'device_revoked'): { device: DeviceRecord; tasks: TaskRecord[]; runs: RunRecord[]; leases: LeaseRecord[] } {
    const device = this.mustGetDevice(deviceId);
    if (device.status === 'REVOKED') return { device, tasks: [], runs: [], leases: [] };
    const now = this.timestamp();
    const revokedDevice: DeviceRecord = {
      ...device,
      status: 'REVOKED',
      revokedAt: now,
      updatedAt: now,
    };
    this.devices.set(device.id, revokedDevice);

    const tasks: TaskRecord[] = [];
    const runs: RunRecord[] = [];
    const leases: LeaseRecord[] = [];
    for (const lease of [...this.leases.values()]) {
      if (lease.deviceId !== device.id || !isActiveLeaseStatus(lease.status)) continue;
      const run = this.runs.get(lease.runId);
      if (!run || run.currentLeaseId !== lease.id || (run.status !== 'LEASED' && run.status !== 'RUNNING')) continue;

      lease.status = 'CANCELLED';
      lease.cancelledAt = now;
      lease.expireReason = reason;
      lease.updatedAt = now;
      lease.version += 1;
      leases.push(lease);

      const cancelledRun = this.updateRun(run.id, { status: 'CANCELLED', finishedAt: now, updatedAt: now });
      runs.push(cancelledRun);

      const task = this.tasks.get(cancelledRun.taskId);
      if (task && task.currentRunId === cancelledRun.id && task.status !== 'SUCCEEDED' && task.status !== 'FAILED' && task.status !== 'CANCELLED') {
        tasks.push(this.updateTask(task.id, { status: 'CANCELLED', updatedAt: now }));
      }
    }
    return { device: revokedDevice, tasks, runs, leases };
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

    let denied: AgentlinkError | undefined;
    const run = [...this.runs.values()].find((candidate) => {
      if (candidate.domain !== device.domain || candidate.status !== 'QUEUED') return false;
      if (this.findActiveLease(candidate.id)) return false;
      const required = getRequiredCapabilities(candidate.instruction);
      const supportedCapabilities = input.supportedCapabilities ?? runner.capabilities;
      const policyDecision = this.evaluatePolicy(candidate, device, runner, required, supportedCapabilities);
      if (policyDecision.decision === 'DENY') {
        denied = new AgentlinkError(403, toExternalPolicyErrorCode(policyDecision.code), policyDecision.reason ?? 'Policy denied');
        return false;
      }
      this.updateRun(candidate.id, { policyDecisionId: policyDecision.id, updatedAt: this.timestamp() });
      return true;
    });
    if (!run && denied) throw denied;
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

  cancelTask(taskId: string, reason = 'user_cancelled'): { task: TaskRecord; run?: RunRecord; lease?: LeaseRecord; controlActions: ControlActionRecord[] } {
    const task = this.mustGetTask(taskId);
    if (task.status === 'SUCCEEDED' || task.status === 'FAILED' || task.status === 'CANCELLED') {
      throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Task is already terminal');
    }

    const now = this.timestamp();
    const run = this.runs.get(task.currentRunId);
    let cancelledRun: RunRecord | undefined;
    let cancelledLease: LeaseRecord | undefined;
    const controlActions: ControlActionRecord[] = [];

    if (run && !isTerminalRunStatus(run.status)) {
      if (run.currentLeaseId) {
        const lease = this.leases.get(run.currentLeaseId);
        if (lease && isActiveLeaseStatus(lease.status)) {
          lease.status = 'CANCELLED';
          lease.cancelledAt = now;
          lease.expireReason = reason;
          lease.updatedAt = now;
          lease.version += 1;
          cancelledLease = lease;
          controlActions.push(this.createControlAction(lease, reason, now));
        }
      }
      cancelledRun = this.updateRun(run.id, { status: 'CANCELLED', finishedAt: now, updatedAt: now });
    }

    const cancelledTask = this.updateTask(task.id, { status: 'CANCELLED', updatedAt: now });
    return { task: cancelledTask, ...(cancelledRun ? { run: cancelledRun } : {}), ...(cancelledLease ? { lease: cancelledLease } : {}), controlActions };
  }

  pollControl(deviceId: string): { controlActions: ControlActionRecord[] } {
    this.mustGetDevice(deviceId);
    const controlActions = [...this.controlActions.values()]
      .filter((action) => action.deviceId === deviceId && action.status === 'PENDING')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { controlActions };
  }

  ackControlAction(deviceId: string, actionId: string): { controlAction: ControlActionRecord } {
    this.mustGetDevice(deviceId);
    const action = this.controlActions.get(actionId);
    if (!action) throw new AgentlinkError(404, 'AL_CONTROL_ACTION_NOT_FOUND', 'Control action not found');
    if (action.deviceId !== deviceId) throw new AgentlinkError(403, 'AL_CONTROL_ACTION_FORBIDDEN', 'Control action does not belong to this device');
    if (action.status === 'ACKED') return { controlAction: action };
    const now = this.timestamp();
    const next: ControlActionRecord = {
      ...action,
      status: 'ACKED',
      acknowledgedAt: now,
      updatedAt: now,
    };
    this.controlActions.set(action.id, next);
    return { controlAction: next };
  }

  recoverDevice(deviceId: string): { recoverableRuns: RecoverableRunRecord[] } {
    this.mustGetDevice(deviceId);
    const recoverableRuns = [...this.leases.values()]
      .filter((lease) => lease.deviceId === deviceId && isActiveLeaseStatus(lease.status))
      .flatMap((lease) => {
        const run = this.runs.get(lease.runId);
        if (!run || run.currentLeaseId !== lease.id || (run.status !== 'LEASED' && run.status !== 'RUNNING')) return [];
        return [{
          runId: run.id,
          taskId: run.taskId,
          leaseId: lease.id,
          runStatus: run.status,
          leaseStatus: lease.status,
          instruction: run.instruction,
          expiresAt: lease.expiresAt,
        }];
      });
    return { recoverableRuns };
  }

  decideRecovery(input: { deviceId: string; leaseId: string; decision: RecoverDecision; reason?: string }): { decision: RecoverDecision; lease: LeaseRecord; run: RunRecord; task: TaskRecord; retryRun?: RunRecord } {
    this.mustGetDevice(input.deviceId);
    const lease = this.mustGetLease(input.leaseId);
    if (lease.deviceId !== input.deviceId) throw new AgentlinkError(403, 'AL_RUN_001', 'Lease does not belong to this device');
    const run = this.mustGetRun(lease.runId);
    if (run.currentLeaseId !== lease.id || !isActiveLeaseStatus(lease.status) || (run.status !== 'LEASED' && run.status !== 'RUNNING')) {
      throw new AgentlinkError(409, 'AL_LEASE_EXPIRED', 'Lease is not recoverable');
    }
    if (input.decision === 'continue') {
      this.mustHaveExecutingLease(run, lease.id);
      const renewed = this.renewLeaseForRecovery(run, lease);
      return { decision: input.decision, ...renewed };
    }
    if (input.decision !== 'discard') {
      throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'decision must be continue or discard');
    }
    const discarded = this.discardRecoverableLease(run, lease, input.reason ?? 'agentlet_recover_discard');
    return { decision: input.decision, ...discarded };
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

  renewLease(leaseId: string): { lease: LeaseRecord; run: RunRecord; task: TaskRecord; controlActions: ControlActionRecord[] } {
    const run = this.mustGetRun(this.mustGetLease(leaseId).runId);
    const lease = this.mustHaveExecutingLease(run, leaseId);
    const renewed = this.renewLeaseForExecution(run, lease);
    return { ...renewed, controlActions: this.pollControl(lease.deviceId).controlActions };
  }

  appendProgress(input: { runId: string; leaseId: string; seq: number; eventType: string; payload?: JsonRecord; retention?: RetentionMetadataInput }): RunEventRecord {
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

    const retention = normalizeRetentionMetadata(input.retention, {
      ...EVENT_RETENTION_DEFAULTS,
    });
    const event: RunEventRecord = {
      runId: run.id,
      seq: input.seq,
      domain: run.domain,
      eventType: input.eventType,
      payload,
      retentionClass: retention.retentionClass,
      memorySpace: retention.memorySpace,
      sourceSystem: retention.sourceSystem,
      sensitivity: retention.sensitivity,
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

  getPolicyDecisions(runId: string): PolicyDecisionRecord[] {
    return [...this.policyDecisions.values()].filter((decision) => decision.runId === runId);
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
    const taskSpec = input.taskSpec ?? {};
    return {
      type: 'codex_session',
      prompt: typeof input.payload?.text === 'string' ? input.payload.text : '',
      requiredCapabilities: getTaskSpecStringArray(taskSpec, 'requiredCapabilities') ?? getTaskSpecStringArray(taskSpec, 'required_capabilities') ?? ['codex:exec'],
      workspace: getTaskSpecString(taskSpec, 'workspace') ?? getTaskSpecString(taskSpec, 'workdir') ?? this.defaultWorkspace,
      networkScope: getTaskSpecString(taskSpec, 'networkScope') ?? getTaskSpecString(taskSpec, 'network_scope') ?? input.domain ?? 'personal',
      workdirAccess: getTaskSpecWorkdirAccess(taskSpec) ?? 'read_write',
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
      retentionClass: task.retentionClass,
      memorySpace: task.memorySpace,
      sourceSystem: task.sourceSystem,
      sensitivity: task.sensitivity,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(nextRun.id, nextRun);
    return nextRun;
  }

  private createControlAction(lease: LeaseRecord, reason: string, now: string): ControlActionRecord {
    const existing = [...this.controlActions.values()].find((action) => action.type === 'cancel_run' && action.leaseId === lease.id);
    if (existing) {
      const refreshed: ControlActionRecord = {
        ...existing,
        reason,
        status: 'PENDING',
        updatedAt: now,
      };
      delete refreshed.acknowledgedAt;
      this.controlActions.set(refreshed.id, refreshed);
      return refreshed;
    }
    const action: ControlActionRecord = {
      id: randomUUID(),
      type: 'cancel_run',
      deviceId: lease.deviceId,
      runId: lease.runId,
      leaseId: lease.id,
      reason,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    this.controlActions.set(action.id, action);
    return action;
  }

  private renewLeaseForExecution(run: RunRecord, lease: LeaseRecord): { lease: LeaseRecord; run: RunRecord; task: TaskRecord } {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    lease.status = 'RENEWED';
    lease.renewedAt = now;
    lease.expiresAt = new Date(nowDate.getTime() + this.leaseTtlMs).toISOString();
    lease.updatedAt = now;
    lease.version += 1;
    const updatedRun = this.updateRun(run.id, { status: 'RUNNING', updatedAt: now, startedAt: run.startedAt ?? now });
    const task = this.updateTask(updatedRun.taskId, { status: 'RUNNING', updatedAt: now });
    return { lease, run: updatedRun, task };
  }

  private renewLeaseForRecovery(run: RunRecord, lease: LeaseRecord): { lease: LeaseRecord; run: RunRecord; task: TaskRecord } {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    lease.status = 'RENEWED';
    lease.renewedAt = now;
    lease.expiresAt = new Date(nowDate.getTime() + this.leaseTtlMs).toISOString();
    lease.updatedAt = now;
    lease.version += 1;
    const updatedRun = this.updateRun(run.id, { status: 'RUNNING', updatedAt: now, startedAt: run.startedAt ?? now });
    const task = this.updateTask(updatedRun.taskId, { status: 'RUNNING', updatedAt: now });
    return { lease, run: updatedRun, task };
  }

  private discardRecoverableLease(run: RunRecord, lease: LeaseRecord, reason: string): { lease: LeaseRecord; run: RunRecord; task: TaskRecord; retryRun?: RunRecord } {
    const now = this.timestamp();
    lease.status = 'EXPIRED';
    lease.expireReason = reason;
    lease.updatedAt = now;
    lease.version += 1;
    const updatedRun = this.updateRun(run.id, { status: 'TIMED_OUT', finishedAt: now, updatedAt: now });
    const taskBeforeRetry = this.updateTask(updatedRun.taskId, { status: 'FAILED', updatedAt: now });
    const retryDecision = decideRetry(
      'lease_expired',
      { retryCount: taskBeforeRetry.retryCount, currentAttemptNo: updatedRun.attemptNo },
      { maxRetries: taskBeforeRetry.maxRetries },
    );
    if (!retryDecision.shouldRetry) return { lease, run: updatedRun, task: taskBeforeRetry };
    const retryRun = this.createRunAttempt(taskBeforeRetry, updatedRun, retryDecision.nextAttemptNo ?? updatedRun.attemptNo + 1, now);
    const task = this.updateTask(taskBeforeRetry.id, {
      status: 'QUEUED',
      currentRunId: retryRun.id,
      retryCount: retryDecision.nextRetryCount ?? taskBeforeRetry.retryCount + 1,
      updatedAt: now,
    });
    return { lease, run: updatedRun, task, retryRun };
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

  private evaluatePolicy(
    run: RunRecord,
    device: DeviceRecord,
    runner: RunnerRecord,
    requiredCapabilities: readonly string[],
    supportedCapabilities: readonly string[],
  ): PolicyDecisionRecord & { code?: 'AL_POLICY_DENIED' | 'AL_NETWORK_SCOPE_DENIED' | 'AL_CAPABILITY_UNDECLARED' | 'AL_CAPABILITY_UNSUPPORTED' | 'AL_CAPABILITY_DENIED' | 'AL_WORKDIR_DENIED' } {
    const task = this.mustGetTask(run.taskId);
    const evaluated = evaluateDispatchPolicy({
      domain: run.domain,
      deviceId: device.id,
      runnerId: runner.id,
      deviceNetworkScope: device.networkScope,
      requestedNetworkScope: getRequestedNetworkScope(run.instruction, device.networkScope),
      requiredCapabilities,
      declaredCapabilities: runner.capabilities,
      supportedCapabilities,
      capabilityGrants: [...this.capabilityGrants.values()],
      workspace: getWorkspace(run.instruction, this.defaultWorkspace),
      requiredWorkdirAccess: getWorkdirAccess(run.instruction),
      workdirGrants: [...this.workdirGrants.values()],
    });
    const decision: PolicyDecisionRecord & { code?: 'AL_POLICY_DENIED' | 'AL_NETWORK_SCOPE_DENIED' | 'AL_CAPABILITY_UNDECLARED' | 'AL_CAPABILITY_UNSUPPORTED' | 'AL_CAPABILITY_DENIED' | 'AL_WORKDIR_DENIED' } = {
      id: randomUUID(),
      domain: run.domain,
      taskId: task.id,
      runId: run.id,
      deviceId: device.id,
      runnerId: runner.id,
      input: evaluated.input,
      decision: evaluated.decision,
      ...(evaluated.reason ? { reason: evaluated.reason } : {}),
      ...(evaluated.code ? { code: evaluated.code } : {}),
      createdAt: this.timestamp(),
    };
    this.policyDecisions.set(decision.id, decision);
    return decision;
  }
}

function getRequiredCapabilities(instruction: JsonRecord): string[] {
  const value = instruction.requiredCapabilities;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : ['codex:exec'];
}

function getWorkspace(instruction: JsonRecord, fallback: string): string {
  return typeof instruction.workspace === 'string' && instruction.workspace.length > 0 ? instruction.workspace : fallback;
}

function getRequestedNetworkScope(instruction: JsonRecord, fallback: string): string {
  return typeof instruction.networkScope === 'string' && instruction.networkScope.length > 0 ? instruction.networkScope : fallback;
}

function getWorkdirAccess(instruction: JsonRecord): WorkdirAccessMode {
  return instruction.workdirAccess === 'read' || instruction.workdirAccess === 'write' || instruction.workdirAccess === 'read_write' ? instruction.workdirAccess : 'read_write';
}

function getTaskSpecString(taskSpec: JsonRecord, key: string): string | undefined {
  const value = taskSpec[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getTaskSpecStringArray(taskSpec: JsonRecord, key: string): string[] | undefined {
  const value = taskSpec[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function getTaskSpecWorkdirAccess(taskSpec: JsonRecord): WorkdirAccessMode | undefined {
  const value = taskSpec.workdirAccess ?? taskSpec.workdir_access ?? taskSpec.access_mode;
  return value === 'read' || value === 'write' || value === 'read_write' ? value : undefined;
}

function toExternalPolicyErrorCode(code: string | undefined): 'AL_POLICY_DENIED' | 'AL_CAPABILITY_DENIED' | 'AL_WORKDIR_DENIED' {
  if (code === 'AL_WORKDIR_DENIED') return 'AL_WORKDIR_DENIED';
  if (code === 'AL_CAPABILITY_DENIED' || code === 'AL_CAPABILITY_UNDECLARED' || code === 'AL_CAPABILITY_UNSUPPORTED') return 'AL_CAPABILITY_DENIED';
  return 'AL_POLICY_DENIED';
}

function hashSecret(secret: string): string {
  return hashStable({ secret });
}
function removeUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export const DEFAULT_WORKSPACE = process.env.AGENTLINK_DEFAULT_WORKSPACE ?? process.cwd();
