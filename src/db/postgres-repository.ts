import { randomUUID } from 'node:crypto';
import { AgentlinkError } from '../control-plane/errors.js';
import type { CreateTaskInput } from '../control-plane/in-memory.js';
import type {
  CapabilityGrantRecord,
  ControlActionRecord,
  DeviceRecord,
  Domain,
  JsonRecord,
  LeaseRecord,
  PolicyDecisionRecord,
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
  TASK_RETENTION_DEFAULTS,
  normalizeRetentionMetadata,
  type RetentionMetadataInput,
  withoutRawRetention,
} from '../domain/retention.js';
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

export interface RegisterDeviceRepositoryInput {
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

export interface RegisterDeviceRepositoryResult {
  device: DeviceRecord;
  runner: RunnerRecord;
  deviceSecret: string;
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

  async getTask(taskId: string): Promise<{ task: TaskRecord; run?: RunRecord } | undefined> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.findTaskById, [taskId]);
    if (result.rowCount === 0) return undefined;
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Task lookup returned rowCount without a row');
    const mapped: { task: TaskRecord; run?: RunRecord } = { task: mapTask(row.task) };
    if (row.run) mapped.run = mapRun(row.run);
    return mapped;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.findRunById, [runId]);
    if (result.rowCount === 0) return undefined;
    return mapRun(requireSingleRow(result, 'AL_INTERNAL', 'Run lookup returned rowCount without a row').run);
  }

  async getLease(leaseId: string): Promise<LeaseRecord | undefined> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.findLeaseById, [leaseId]);
    if (result.rowCount === 0) return undefined;
    return mapLease(requireSingleRow(result, 'AL_INTERNAL', 'Lease lookup returned rowCount without a row').lease);
  }

  async getRunEvents(runId: string, afterSeq = 0): Promise<RunEventRecord[]> {
    const result = await this.client.query<RunEventRow>(PostgreSqlStatements.listRunEvents, [runId, afterSeq]);
    return result.rows.map(mapRunEvent);
  }

  async registerDevice(input: RegisterDeviceRepositoryInput): Promise<RegisterDeviceRepositoryResult> {
    const domain = input.domain ?? 'personal';
    const runnerInput = input.runner ?? {};
    const capabilities = runnerInput.capabilities ?? ['codex:exec'];
    for (const capability of input.capabilityGrants ?? []) {
      if (!capabilities.includes(capability)) {
        throw new AgentlinkError(403, 'AL_CAPABILITY_DENIED', 'Capability must be declared before it can be granted');
      }
    }
    for (const grant of input.workdirGrants ?? []) {
      if (!grant.pathPrefix.startsWith('/')) {
        throw new AgentlinkError(403, 'AL_WORKDIR_DENIED', 'Workdir grant path_prefix must be absolute');
      }
    }

    return await withTransaction(this.client, async (tx) => {
      const now = this.timestamp();
      const deviceSecret = `al_dev_${randomUUID().replaceAll('-', '')}`;
      const deviceId = randomUUID();
      const runnerId = randomUUID();
      const device = mapDevice(requireSingleRow(
        await tx.query<EnvelopeRow>(PostgreSqlStatements.insertDevice, [
          deviceId,
          domain,
          input.displayName,
          hashSecret(deviceSecret),
          input.networkScope ?? 'personal',
          input.ownerUserId,
          input.trustLevel ?? 'standard',
          input.agentletVersion ?? null,
          toJsonbParam(input.metadata ?? {}),
          now,
        ]),
        'AL_INTERNAL',
        'Device insert returned no row',
      ));
      const runner = mapRunner(requireSingleRow(
        await tx.query<EnvelopeRow>(PostgreSqlStatements.insertRunner, [
          runnerId,
          device.id,
          runnerInput.runnerType ?? 'codex',
          runnerInput.runnerVersion ?? null,
          runnerInput.model ?? null,
          runnerInput.maxConcurrency ?? 1,
          now,
        ]),
        'AL_INTERNAL',
        'Runner insert returned no row',
      ), capabilities);

      for (const capability of capabilities) {
        await tx.query(PostgreSqlStatements.insertCapabilityDeclared, [device.id, runner.id, capability, 'runner', now]);
      }
      for (const capability of input.capabilityGrants ?? []) {
        await tx.query(PostgreSqlStatements.insertCapabilityGrant, [randomUUID(), domain, device.id, runner.id, capability, 'device_register', now]);
      }
      for (const grant of input.workdirGrants ?? []) {
        await tx.query(PostgreSqlStatements.insertWorkdirGrant, [randomUUID(), domain, device.id, grant.pathPrefix, grant.accessMode ?? 'read_write', now]);
      }
      return { device, runner, deviceSecret };
    });
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.findDeviceById, [deviceId]);
    if (result.rowCount === 0) return undefined;
    return mapDevice(requireSingleRow(result, 'AL_INTERNAL', 'Device lookup returned rowCount without a row').device);
  }

  async getRunner(runnerId: string): Promise<RunnerRecord | undefined> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.findRunnerById, [runnerId]);
    if (result.rowCount === 0) return undefined;
    return mapRunner(requireSingleRow(result, 'AL_INTERNAL', 'Runner lookup returned rowCount without a row').runner);
  }

  async authenticateDevice(deviceId: string, deviceSecret: string): Promise<DeviceRecord> {
    const device = await this.getDevice(deviceId);
    if (!device) throw new AgentlinkError(404, 'AL_DEVICE_NOT_FOUND', 'Device not found');
    if (device.status === 'REVOKED') throw new AgentlinkError(401, 'AL_TOKEN_REVOKED', 'Device token was revoked');
    if (device.tokenHash !== hashSecret(deviceSecret)) throw new AgentlinkError(401, 'AL_AUTH_INVALID', 'Invalid device token');
    return device;
  }

  async heartbeat(deviceId: string, deviceSecret: string): Promise<DeviceRecord> {
    await this.authenticateDevice(deviceId, deviceSecret);
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.heartbeatDevice, [deviceId, this.timestamp()]);
    if (result.rowCount === 0) throw new AgentlinkError(401, 'AL_TOKEN_REVOKED', 'Device token was revoked');
    return mapDevice(requireSingleRow(result, 'AL_INTERNAL', 'Heartbeat returned rowCount without a row'));
  }

  async createTaskWithInitialRun(input: CreateTaskInput, idempotencyKey: string): Promise<CreateTaskRepositoryResult> {
    if (!idempotencyKey) throw new AgentlinkError(400, 'AL_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    const domain = input.domain ?? 'personal';
    const retention = normalizeRetentionMetadata(input.retention, TASK_RETENTION_DEFAULTS);
    const signature = createTaskIdempotencySignature(domain, input, retention);

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
          retention.retentionClass,
          retention.memorySpace,
          retention.sourceSystem,
          retention.sensitivity,
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

  async pullNextPolicyApprovedRun(input: LeaseNextQueuedRunInput & { supportedCapabilities?: readonly string[] }): Promise<LeaseNextQueuedRunResult | undefined> {
    const device = await this.getDevice(input.deviceId);
    if (!device) throw new AgentlinkError(404, 'AL_DEVICE_NOT_FOUND', 'Device not found');
    if (device.status !== 'ONLINE') throw new AgentlinkError(503, 'AL_DEVICE_OFFLINE', 'Device must be ONLINE before pulling work');
    const runner = await this.getRunner(input.runnerId);
    if (!runner || runner.deviceId !== device.id || runner.status !== 'online') {
      throw new AgentlinkError(403, 'AL_RUN_001', 'Runner is not available for this device');
    }

    const candidates = await this.client.query<EnvelopeRow>(PostgreSqlStatements.findDispatchCandidates, [input.domain ?? device.domain, 10]);
    let denied: AgentlinkError | undefined;
    for (const row of candidates.rows) {
      const run = mapRun(row.run);
      const task = mapTask(row.task);
      const requiredCapabilities = getRequiredCapabilities(run.instruction);
      const supportedCapabilities = input.supportedCapabilities ?? runner.capabilities;
      const capabilityGrants = await this.findActiveCapabilityGrantsForRunner(run.domain, device.id, runner.id, requiredCapabilities);
      const workdirGrants = await this.findActiveWorkdirGrantsForDevice(run.domain, device.id);
      const evaluated = evaluateDispatchPolicy({
        domain: run.domain,
        deviceId: device.id,
        runnerId: runner.id,
        deviceNetworkScope: device.networkScope,
        requestedNetworkScope: getRequestedNetworkScope(run.instruction, device.networkScope),
        requiredCapabilities,
        declaredCapabilities: runner.capabilities,
        supportedCapabilities,
        capabilityGrants,
        workspace: getWorkspace(run.instruction, DEFAULT_WORKSPACE),
        requiredWorkdirAccess: getWorkdirAccess(run.instruction),
        workdirGrants,
      });
      const policyInput: {
        domain: Domain;
        taskId: string;
        runId: string;
        deviceId: string;
        runnerId: string;
        input: JsonRecord;
        decision: 'ALLOW' | 'DENY';
        reason?: string;
      } = {
        domain: run.domain,
        taskId: task.id,
        runId: run.id,
        deviceId: device.id,
        runnerId: runner.id,
        input: evaluated.input,
        decision: evaluated.decision,
      };
      if (evaluated.reason) policyInput.reason = evaluated.reason;
      const decision = await this.insertPolicyDecision(policyInput);
      if (evaluated.decision === 'DENY') {
        denied = new AgentlinkError(403, toExternalPolicyErrorCode(evaluated.code), evaluated.reason ?? 'Policy denied');
        continue;
      }

      const leased = await this.leaseSpecificQueuedRun({
        runId: run.id,
        deviceId: device.id,
        runnerId: runner.id,
        domain: run.domain,
        policyDecisionId: decision.id,
      });
      if (leased) return leased;
    }
    if (denied) throw denied;
    return undefined;
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

  async leaseSpecificQueuedRun(input: { runId: string; deviceId: string; runnerId: string; domain: Domain; policyDecisionId?: string }): Promise<LeaseNextQueuedRunResult | undefined> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + this.leaseTtlMs).toISOString();
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.leaseSpecificQueuedRun, [
      input.runId,
      input.deviceId,
      input.runnerId,
      input.domain,
      randomUUID(),
      now,
      expiresAt,
      input.policyDecisionId ?? null,
    ]);
    if (result.rowCount === 0) return undefined;
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Specific lease query returned rowCount without a row');
    return { lease: mapLease(row.lease), run: mapRun(row.run), task: mapTask(row.task) };
  }

  async findActiveCapabilityGrantsForRunner(domain: Domain, deviceId: string, runnerId: string, capabilities: readonly string[]): Promise<CapabilityGrantRecord[]> {
    if (capabilities.length === 0) return [];
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.findActiveCapabilityGrantsForRunner, [domain, deviceId, runnerId, capabilities]);
    return result.rows.map(mapCapabilityGrant);
  }

  async listCapabilityGrants(deviceId: string): Promise<CapabilityGrantRecord[]> {
    await this.mustGetDevice(deviceId);
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.listCapabilityGrantsForDevice, [deviceId]);
    return result.rows.map(mapCapabilityGrant);
  }

  async grantCapability(input: { deviceId: string; runnerId: string; capability: string; grantedBy: string }): Promise<CapabilityGrantRecord> {
    const device = await this.mustGetDevice(input.deviceId);
    if (device.status === 'REVOKED') throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Cannot grant capabilities to a revoked device');
    const runner = await this.getRunner(input.runnerId);
    if (!runner) throw new AgentlinkError(404, 'AL_RUNNER_NOT_FOUND', 'Runner not found');
    if (runner.deviceId !== device.id) throw new AgentlinkError(403, 'AL_POLICY_DENIED', 'Runner does not belong to device');
    if (!runner.capabilities.includes(input.capability)) {
      throw new AgentlinkError(403, 'AL_CAPABILITY_DENIED', 'Capability must be declared before it can be granted');
    }
    const existing = await this.findActiveCapabilityGrantsForRunner(device.domain, device.id, runner.id, [input.capability]);
    if (existing[0]) return existing[0];
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.insertCapabilityGrant, [
      randomUUID(),
      device.domain,
      device.id,
      runner.id,
      input.capability,
      input.grantedBy,
      this.timestamp(),
    ]);
    return mapCapabilityGrant(requireSingleRow(result, 'AL_INTERNAL', 'Capability grant insert returned no row'));
  }

  async revokeCapabilityGrant(grantId: string): Promise<CapabilityGrantRecord> {
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.revokeCapabilityGrant, [grantId, this.timestamp()]);
    if (result.rowCount === 0) throw new AgentlinkError(404, 'AL_CAPABILITY_GRANT_NOT_FOUND', 'Capability grant not found');
    return mapCapabilityGrant(requireSingleRow(result, 'AL_INTERNAL', 'Capability grant revoke returned no row'));
  }

  async findActiveWorkdirGrantsForDevice(domain: Domain, deviceId: string): Promise<WorkdirGrantRecord[]> {
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.findActiveWorkdirGrantsForDevice, [domain, deviceId]);
    return result.rows.map(mapWorkdirGrant);
  }

  async listWorkdirGrants(deviceId: string): Promise<WorkdirGrantRecord[]> {
    await this.mustGetDevice(deviceId);
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.listWorkdirGrantsForDevice, [deviceId]);
    return result.rows.map(mapWorkdirGrant);
  }

  async grantWorkdir(input: { deviceId: string; pathPrefix: string; accessMode?: WorkdirAccessMode }): Promise<WorkdirGrantRecord> {
    const device = await this.mustGetDevice(input.deviceId);
    if (device.status === 'REVOKED') throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Cannot grant workdirs to a revoked device');
    if (!input.pathPrefix.startsWith('/')) throw new AgentlinkError(403, 'AL_WORKDIR_DENIED', 'Workdir grant path_prefix must be absolute');
    const accessMode = input.accessMode ?? 'read_write';
    const existing = (await this.findActiveWorkdirGrantsForDevice(device.domain, device.id)).find(
      (grant) => grant.pathPrefix === input.pathPrefix && grant.accessMode === accessMode,
    );
    if (existing) return existing;
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.insertWorkdirGrant, [
      randomUUID(),
      device.domain,
      device.id,
      input.pathPrefix,
      accessMode,
      this.timestamp(),
    ]);
    return mapWorkdirGrant(requireSingleRow(result, 'AL_INTERNAL', 'Workdir grant insert returned no row'));
  }

  async revokeWorkdirGrant(grantId: string): Promise<WorkdirGrantRecord> {
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.revokeWorkdirGrant, [grantId, this.timestamp()]);
    if (result.rowCount === 0) throw new AgentlinkError(404, 'AL_WORKDIR_GRANT_NOT_FOUND', 'Workdir grant not found');
    return mapWorkdirGrant(requireSingleRow(result, 'AL_INTERNAL', 'Workdir grant revoke returned no row'));
  }

  async insertPolicyDecision(input: {
    domain: Domain;
    taskId?: string;
    runId?: string;
    deviceId?: string;
    runnerId?: string;
    input: JsonRecord;
    decision: 'ALLOW' | 'DENY';
    reason?: string;
  }): Promise<PolicyDecisionRecord> {
    const result = await this.client.query<Record<string, unknown>>(PostgreSqlStatements.insertPolicyDecision, [
      randomUUID(),
      input.domain,
      input.taskId ?? null,
      input.runId ?? null,
      input.deviceId ?? null,
      input.runnerId ?? null,
      toJsonbParam(input.input),
      input.decision,
      input.reason ?? null,
      this.timestamp(),
    ]);
    return mapPolicyDecision(requireSingleRow(result, 'AL_INTERNAL', 'Policy decision insert returned rowCount without a row'));
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

  async renewLease(leaseId: string): Promise<LeaseNextQueuedRunResult> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + this.leaseTtlMs).toISOString();
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.renewLease, [leaseId, now, expiresAt]);
    if (result.rowCount === 0) throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Lease must be ACKED or RENEWED and Run must be RUNNING');
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Renew returned rowCount without a row');
    return { lease: mapLease(row.lease), run: mapRun(row.run), task: mapTask(row.task) };
  }

  async appendAgentletProgress(input: { runId: string; leaseId: string; seq: number; eventType: string; payload?: JsonRecord; retention?: RetentionMetadataInput }): Promise<RunEventRecord> {
    if (!Number.isInteger(input.seq) || input.seq <= 0) {
      throw new AgentlinkError(400, 'AL_EVENT_SEQ_INVALID', 'Progress seq must be a positive integer');
    }
    const payload = input.payload ?? {};
    const retention = normalizeRetentionMetadata(input.retention, EVENT_RETENTION_DEFAULTS);
    const inserted = await this.client.query<RunEventRow>(PostgreSqlStatements.appendAgentletProgress, [
      input.runId,
      input.leaseId,
      input.seq,
      input.eventType,
      toJsonbParam(payload),
      retention.retentionClass,
      retention.memorySpace,
      retention.sourceSystem,
      retention.sensitivity,
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

  async cancelTask(taskId: string, reason = 'user_cancelled'): Promise<{ task: TaskRecord; run?: RunRecord; lease?: LeaseRecord; controlAction?: ControlActionRecord }> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.cancelTask, [taskId, this.timestamp(), reason, randomUUID()]);
    if (result.rowCount === 0) throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Task cannot be cancelled');
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Cancel returned rowCount without a row');
    const mapped: { task: TaskRecord; run?: RunRecord; lease?: LeaseRecord; controlAction?: ControlActionRecord } = { task: mapTask(row.task) };
    if (row.run) mapped.run = mapRun(row.run);
    if (row.lease) mapped.lease = mapLease(row.lease);
    if (row.control_action) mapped.controlAction = mapControlAction(row.control_action);
    return mapped;
  }

  async revokeDevice(deviceId: string, reason = 'device_revoked'): Promise<{ device: DeviceRecord; tasks: TaskRecord[]; runs: RunRecord[]; leases: LeaseRecord[] }> {
    return await withTransaction(this.client, async (tx) => {
      const now = this.timestamp();
      const deviceResult = await tx.query<EnvelopeRow>(PostgreSqlStatements.revokeDevice, [deviceId, now]);
      if (deviceResult.rowCount === 0) throw new AgentlinkError(404, 'AL_DEVICE_NOT_FOUND', 'Device not found');
      const cancelled = await tx.query<EnvelopeRow>(PostgreSqlStatements.cancelActiveLeasesForDevice, [deviceId, now, reason]);
      const tasks: TaskRecord[] = [];
      const runs: RunRecord[] = [];
      const leases: LeaseRecord[] = [];
      for (const row of cancelled.rows) {
        if (row.task) tasks.push(mapTask(row.task));
        if (row.run) runs.push(mapRun(row.run));
        if (row.lease) leases.push(mapLease(row.lease));
      }
      return {
        device: mapDevice(requireSingleRow(deviceResult, 'AL_INTERNAL', 'Device revoke returned no row').device),
        tasks,
        runs,
        leases,
      };
    });
  }

  async listControlActionsForDevice(deviceId: string, limit = 50): Promise<ControlActionRecord[]> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.listControlActionsForDevice, [deviceId, limit]);
    return result.rows.map((row) => mapControlAction(row.control_action));
  }

  async ackControlAction(deviceId: string, actionId: string): Promise<ControlActionRecord> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.ackControlAction, [actionId, deviceId, this.timestamp()]);
    if (result.rowCount === 0) throw new AgentlinkError(404, 'AL_CONTROL_ACTION_NOT_FOUND', 'Control action not found');
    return mapControlAction(requireSingleRow(result, 'AL_INTERNAL', 'Control action ack returned rowCount without a row').control_action);
  }

  async listRecoverableRunsForDevice(deviceId: string, limit = 50): Promise<RecoverableRunRecord[]> {
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.listRecoverableRunsForDevice, [deviceId, limit]);
    return result.rows.map((row) => {
      const lease = mapLease(row.lease);
      const run = mapRun(row.run);
      return {
        runId: run.id,
        taskId: run.taskId,
        leaseId: lease.id,
        runStatus: run.status,
        leaseStatus: lease.status,
        instruction: run.instruction,
        expiresAt: lease.expiresAt,
      };
    });
  }

  async recoverContinue(leaseId: string, deviceId: string): Promise<LeaseNextQueuedRunResult> {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + this.leaseTtlMs).toISOString();
    const result = await this.client.query<EnvelopeRow>(PostgreSqlStatements.recoverContinue, [leaseId, deviceId, now, expiresAt]);
    if (result.rowCount === 0) {
      const recoverable = await this.client.query<EnvelopeRow>(PostgreSqlStatements.findRecoverableLeaseForDecision, [leaseId, deviceId]);
      if (recoverable.rowCount > 0) {
        throw new AgentlinkError(409, 'AL_STATE_CONFLICT', 'Lease must be ACKED or RENEWED and Run must be RUNNING');
      }
      throw new AgentlinkError(409, 'AL_LEASE_EXPIRED', 'Lease is not recoverable');
    }
    const row = requireSingleRow(result, 'AL_INTERNAL', 'Recover continue returned rowCount without a row');
    return { lease: mapLease(row.lease), run: mapRun(row.run), task: mapTask(row.task) };
  }

  async recoverDiscard(leaseId: string, deviceId: string, reason = 'agentlet_recover_discard'): Promise<ExpireLeaseResult> {
    return await withTransaction(this.client, async (tx) => {
      const discarded = await tx.query<EnvelopeRow>(PostgreSqlStatements.recoverDiscard, [leaseId, deviceId, reason, this.timestamp()]);
      if (discarded.rowCount === 0) throw new AgentlinkError(409, 'AL_LEASE_EXPIRED', 'Lease is not recoverable');
      const row = requireSingleRow(discarded, 'AL_INTERNAL', 'Recover discard returned rowCount without a row');
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

  private async mustGetDevice(deviceId: string): Promise<DeviceRecord> {
    const device = await this.getDevice(deviceId);
    if (!device) throw new AgentlinkError(404, 'AL_DEVICE_NOT_FOUND', 'Device not found');
    return device;
  }
}

export function createTaskIdempotencySignature(domain: Domain, input: CreateTaskInput, retention: RetentionMetadataInput | undefined): string {
  return stableStringify({ domain, input: withoutRawRetention(input), retention });
}

interface EnvelopeRow {
  task?: unknown;
  run?: unknown;
  lease?: unknown;
  control_action?: unknown;
  device?: unknown;
  runner?: unknown;
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
    retentionClass: readRetentionClass(row, 'retention_class'),
    memorySpace: readString(row, 'memory_space'),
    sourceSystem: readString(row, 'source_system'),
    sensitivity: readSensitivity(row, 'sensitivity'),
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
    retentionClass: readRetentionClass(row, 'retention_class'),
    memorySpace: readString(row, 'memory_space'),
    sourceSystem: readString(row, 'source_system'),
    sensitivity: readSensitivity(row, 'sensitivity'),
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
    retentionClass: readRetentionClass(row, 'retention_class'),
    memorySpace: readString(row, 'memory_space'),
    sourceSystem: readString(row, 'source_system'),
    sensitivity: readSensitivity(row, 'sensitivity'),
    emittedAt: readTimestamp(row, 'emitted_at'),
  };
}

function mapControlAction(value: unknown): ControlActionRecord {
  const row = asRecord(value, 'control_action');
  const record: ControlActionRecord = {
    id: readString(row, 'id'),
    type: readString(row, 'action_type') as ControlActionRecord['type'],
    deviceId: readString(row, 'device_id'),
    runId: readString(row, 'run_id'),
    leaseId: readString(row, 'lease_id'),
    reason: readString(row, 'reason'),
    status: readString(row, 'status') as ControlActionRecord['status'],
    createdAt: readTimestamp(row, 'created_at'),
    updatedAt: readTimestamp(row, 'updated_at'),
  };
  setOptionalTimestamp(record, 'acknowledgedAt', row.acknowledged_at);
  return record;
}

function mapDevice(value: unknown): DeviceRecord {
  const row = asRecord(value, 'device');
  const record: DeviceRecord = {
    id: readString(row, 'id'),
    domain: readDomain(row, 'domain'),
    displayName: readString(row, 'display_name'),
    tokenHash: readString(row, 'token_hash'),
    networkScope: readString(row, 'network_scope'),
    ownerUserId: readString(row, 'owner_user_id'),
    trustLevel: readString(row, 'trust_level') as DeviceRecord['trustLevel'],
    status: readString(row, 'status') as DeviceRecord['status'],
    metadata: readJsonRecord(row, 'metadata'),
    createdAt: readTimestamp(row, 'created_at'),
    updatedAt: readTimestamp(row, 'updated_at'),
  };
  setOptionalString(record, 'agentletVersion', row.agentlet_version);
  setOptionalTimestamp(record, 'lastAuthAt', row.last_auth_at);
  setOptionalTimestamp(record, 'lastHeartbeatAt', row.last_heartbeat_at);
  setOptionalTimestamp(record, 'revokedAt', row.revoked_at);
  return record;
}

function mapRunner(value: unknown, capabilitiesOverride?: readonly string[]): RunnerRecord {
  const row = asRecord(value, 'runner');
  return {
    id: readString(row, 'id'),
    deviceId: readString(row, 'device_id'),
    runnerType: readString(row, 'runner_type'),
    ...(typeof row.runner_version === 'string' ? { runnerVersion: row.runner_version } : {}),
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    status: readString(row, 'status') as RunnerRecord['status'],
    maxConcurrency: readNumber(row, 'max_concurrency'),
    capabilities: capabilitiesOverride ?? readStringArray(row, 'capabilities'),
    createdAt: readTimestamp(row, 'created_at'),
    updatedAt: readTimestamp(row, 'updated_at'),
  };
}

function mapCapabilityGrant(value: unknown): CapabilityGrantRecord {
  const row = asRecord(value, 'capability_grant');
  const record: CapabilityGrantRecord = {
    id: readString(row, 'id'),
    domain: readDomain(row, 'domain'),
    deviceId: readString(row, 'device_id'),
    runnerId: readString(row, 'runner_id'),
    capability: readString(row, 'capability'),
    grantStatus: readString(row, 'grant_status') as CapabilityGrantRecord['grantStatus'],
    grantedBy: readString(row, 'granted_by'),
    grantedAt: readTimestamp(row, 'granted_at'),
  };
  setOptionalTimestamp(record, 'revokedAt', row.revoked_at);
  return record;
}

function mapWorkdirGrant(value: unknown): WorkdirGrantRecord {
  const row = asRecord(value, 'workdir_grant');
  const record: WorkdirGrantRecord = {
    id: readString(row, 'id'),
    domain: readDomain(row, 'domain'),
    deviceId: readString(row, 'device_id'),
    pathPrefix: readString(row, 'path_prefix'),
    accessMode: readString(row, 'access_mode') as WorkdirAccessMode,
    createdAt: readTimestamp(row, 'created_at'),
  };
  setOptionalTimestamp(record, 'revokedAt', row.revoked_at);
  return record;
}

function mapPolicyDecision(value: unknown): PolicyDecisionRecord {
  const row = asRecord(value, 'policy_decision');
  const record: PolicyDecisionRecord = {
    id: readString(row, 'id'),
    domain: readDomain(row, 'domain'),
    input: readJsonRecord(row, 'input'),
    decision: readString(row, 'decision') as PolicyDecisionRecord['decision'],
    createdAt: readTimestamp(row, 'created_at'),
  };
  setOptionalString(record, 'taskId', row.task_id);
  setOptionalString(record, 'runId', row.run_id);
  setOptionalString(record, 'deviceId', row.device_id);
  setOptionalString(record, 'runnerId', row.runner_id);
  setOptionalString(record, 'reason', row.reason);
  return record;
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

function readStringArray(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
  throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${key} must be a string array`);
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

function readRetentionClass(row: Record<string, unknown>, key: string): TaskRecord['retentionClass'] {
  const value = readString(row, key);
  if (
    value !== 'short_term' &&
    value !== 'operational' &&
    value !== 'artifact' &&
    value !== 'audit' &&
    value !== 'memory_candidate' &&
    value !== 'memory'
  ) {
    throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${key} must be a retention class`);
  }
  return value;
}

function readSensitivity(row: Record<string, unknown>, key: string): TaskRecord['sensitivity'] {
  const value = readString(row, key);
  if (value !== 'public' && value !== 'internal' && value !== 'confidential' && value !== 'secret') {
    throw new AgentlinkError(500, 'AL_REPOSITORY_MAPPING', `${key} must be a sensitivity`);
  }
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

function hashSecret(secret: string): string {
  return hashStable({ secret });
}

function getRequiredCapabilities(instruction: JsonRecord): string[] {
  const value = instruction.requiredCapabilities ?? instruction.required_capabilities;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : ['codex:exec'];
}

function getWorkspace(instruction: JsonRecord, fallback: string): string {
  return typeof instruction.workspace === 'string' && instruction.workspace.length > 0 ? instruction.workspace : fallback;
}

function getRequestedNetworkScope(instruction: JsonRecord, fallback: string): string {
  return typeof instruction.networkScope === 'string' && instruction.networkScope.length > 0
    ? instruction.networkScope
    : typeof instruction.network_scope === 'string' && instruction.network_scope.length > 0
      ? instruction.network_scope
      : fallback;
}

function getWorkdirAccess(instruction: JsonRecord): WorkdirAccessMode {
  const value = instruction.workdirAccess ?? instruction.workdir_access ?? instruction.access_mode;
  return value === 'read' || value === 'write' || value === 'read_write' ? value : 'read_write';
}

function toExternalPolicyErrorCode(code: string | undefined): 'AL_POLICY_DENIED' | 'AL_CAPABILITY_DENIED' | 'AL_WORKDIR_DENIED' {
  if (code === 'AL_WORKDIR_DENIED') return 'AL_WORKDIR_DENIED';
  if (code === 'AL_CAPABILITY_DENIED' || code === 'AL_CAPABILITY_UNDECLARED' || code === 'AL_CAPABILITY_UNSUPPORTED') return 'AL_CAPABILITY_DENIED';
  return 'AL_POLICY_DENIED';
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
