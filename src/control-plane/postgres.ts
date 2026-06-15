import { AgentlinkError } from './errors.js';
import type { AgentlinkControlPlanePort } from './port.js';
import type { AgentletInstruction, CreateTaskInput, PullInput, RegisterDeviceInput } from './in-memory.js';
import type { JsonRecord, LeaseRecord, MainUserRecord } from '../domain/entities.js';
import type { RetentionMetadataInput } from '../domain/retention.js';
import { PostgreSqlRepository } from '../db/postgres-repository.js';
import { PgRuntime } from '../db/pg-client.js';

export interface PostgresControlPlaneOptions {
  leaseTtlMs?: number;
  now?: () => Date;
  sourceHashSecret?: string;
}

export class PostgresControlPlane implements AgentlinkControlPlanePort {
  constructor(private readonly runtime: PgRuntime, private readonly options: PostgresControlPlaneOptions = {}) {}

  async createTask(input: CreateTaskInput, idempotencyKey: string) {
    return await this.withRepository((repository) => repository.createTaskWithInitialRun(input, idempotencyKey));
  }

  async getTask(taskId: string) {
    return (await this.withRepository((repository) => repository.getTask(taskId)))?.task;
  }

  async getRun(runId: string) {
    return await this.withRepository((repository) => repository.getRun(runId));
  }

  async getLease(leaseId: string) {
    return await this.withRepository((repository) => repository.getLease(leaseId));
  }

  async getRunEvents(runId: string, afterSeq = 0) {
    return await this.withRepository((repository) => repository.getRunEvents(runId, afterSeq));
  }

  async registerDevice(input: RegisterDeviceInput) {
    return await this.withRepository((repository) => repository.registerDevice(input));
  }

  async listCapabilityGrants(deviceId: string) {
    return await this.withRepository((repository) => repository.listCapabilityGrants(deviceId));
  }

  async grantCapability(input: { deviceId: string; runnerId: string; capability: string; grantedBy: string }) {
    return await this.withRepository((repository) => repository.grantCapability(input));
  }

  async revokeCapabilityGrant(grantId: string) {
    return await this.withRepository((repository) => repository.revokeCapabilityGrant(grantId));
  }

  async listWorkdirGrants(deviceId: string) {
    return await this.withRepository((repository) => repository.listWorkdirGrants(deviceId));
  }

  async grantWorkdir(input: { deviceId: string; pathPrefix: string; accessMode?: 'read' | 'write' | 'read_write' }) {
    return await this.withRepository((repository) => repository.grantWorkdir(input));
  }

  async revokeWorkdirGrant(grantId: string) {
    return await this.withRepository((repository) => repository.revokeWorkdirGrant(grantId));
  }

  async getMainUserProfile(): Promise<MainUserRecord | undefined> {
    return await this.withRepository((repository) => repository.getMainUserProfile());
  }

  async upsertMainUserProfile(input: { displayName?: string; locale?: string; timezone?: string; metadata?: JsonRecord; retention?: RetentionMetadataInput }) {
    return await this.withRepository((repository) => repository.upsertMainUserProfile(input));
  }

  async upsertChannelUser(input: {
    platform: string;
    externalId: string;
    displayName?: string;
    channelUserMetadata?: JsonRecord;
    platformIdentityMetadata?: JsonRecord;
    retention?: RetentionMetadataInput;
  }) {
    return await this.withRepository((repository) => repository.upsertChannelUser(input));
  }

  async setChannelUserCategory(input: { channelUserId: string; category: string }) {
    return await this.withRepository((repository) => repository.setChannelUserCategory(input));
  }

  async resolvePlatformIdentity(input: { platform: string; externalId: string }) {
    return await this.withRepository((repository) => repository.resolvePlatformIdentity(input));
  }

  async upsertGroupProfile(input: {
    platform: string;
    externalGroupId: string;
    displayName?: string;
    groupType?: string;
    tone?: string;
    defaultReplyMode?: string;
    contextScope?: string;
    memoryScope?: string;
    metadata?: JsonRecord;
    retention?: RetentionMetadataInput;
  }) {
    return await this.withRepository((repository) => repository.upsertGroupProfile(input));
  }

  async getGroupProfile(id: string) {
    return await this.withRepository((repository) => repository.getGroupProfile(id));
  }

  async resolveGroupProfile(input: { platform: string; externalGroupId: string }) {
    return await this.withRepository((repository) => repository.resolveGroupProfile(input));
  }

  async setGroupProfileDefaults(input: {
    groupProfileId: string;
    defaultReplyMode?: string;
    contextScope?: string;
    memoryScope?: string;
    tone?: string;
  }) {
    return await this.withRepository((repository) => repository.setGroupProfileDefaults(input));
  }

  async ingestSourceEvent(input: {
    sourceSystem: string;
    sourceRef: string;
    eventType: string;
    platform?: string;
    occurredAt?: string;
    payload?: JsonRecord;
    metadata?: JsonRecord;
    entryType?: string;
    externalChatId?: string;
    externalThreadId?: string;
    externalMessageId?: string;
    speakerChannelUserId?: string;
    groupProfileId?: string;
    agentMentioned?: boolean;
    bodyText?: string;
    entryMetadata?: JsonRecord;
    retention?: RetentionMetadataInput;
  }) {
    return await this.withRepository((repository) => repository.ingestSourceEvent(input));
  }

  async getSourceEvent(id: string) {
    return await this.withRepository((repository) => repository.getSourceEvent(id));
  }

  async resolveSourceEvent(input: { sourceSystem: string; sourceRef: string }) {
    return await this.withRepository((repository) => repository.resolveSourceEvent(input));
  }

  async getEntry(id: string) {
    return await this.withRepository((repository) => repository.getEntry(id));
  }

  async getEntryBySourceEvent(sourceEventId: string) {
    return await this.withRepository((repository) => repository.getEntryBySourceEvent(sourceEventId));
  }

  async revokeDevice(deviceId: string, reason?: string) {
    return await this.withRepository((repository) => repository.revokeDevice(deviceId, reason));
  }

  async heartbeat(deviceId: string, deviceSecret: string) {
    return await this.withRepository((repository) => repository.heartbeat(deviceId, deviceSecret));
  }

  async authenticateDevice(deviceId: string, deviceSecret: string) {
    return await this.withRepository((repository) => repository.authenticateDevice(deviceId, deviceSecret));
  }

  async pull(input: PullInput): Promise<AgentletInstruction | undefined> {
    const result = await this.withRepository((repository) => repository.pullNextPolicyApprovedRun(input));
    if (!result) return undefined;
    return {
      runId: result.run.id,
      taskId: result.task.id,
      leaseId: result.lease.id,
      expiresAt: result.lease.expiresAt,
      instruction: result.run.instruction,
    };
  }

  async cancelTask(taskId: string, reason?: string) {
    return await this.withRepository(async (repository) => {
      const cancelled = await repository.cancelTask(taskId, reason);
      const controlActions = cancelled.controlAction ? [cancelled.controlAction] : [];
      return { ...cancelled, controlActions };
    });
  }

  async pollControl(deviceId: string) {
    return await this.withRepository(async (repository) => ({ controlActions: await repository.listControlActionsForDevice(deviceId) }));
  }

  async ackControlAction(deviceId: string, actionId: string) {
    return await this.withRepository(async (repository) => ({ controlAction: await repository.ackControlAction(deviceId, actionId) }));
  }

  async recoverDevice(deviceId: string) {
    return await this.withRepository(async (repository) => ({ recoverableRuns: await repository.listRecoverableRunsForDevice(deviceId) }));
  }

  async decideRecovery(input: { deviceId: string; leaseId: string; decision: 'continue' | 'discard'; reason?: string }) {
    return await this.withRepository(async (repository) => {
      if (input.decision === 'continue') {
        const continued = await repository.recoverContinue(input.leaseId, input.deviceId);
        return { decision: input.decision, ...continued };
      }
      const discarded = await repository.recoverDiscard(input.leaseId, input.deviceId, input.reason);
      return { decision: input.decision, ...discarded };
    });
  }

  async ackLease(leaseId: string, accepted: boolean, reason?: string) {
    return await this.withRepository(async (repository) => {
      const deviceId = await this.mustDeviceIdFromLease(repository, leaseId);
      return accepted ? await repository.ackLeaseAccepted(leaseId, deviceId) : await repository.ackLeaseRejected(leaseId, deviceId, reason);
    });
  }

  async renewLease(leaseId: string) {
    return await this.withRepository(async (repository) => {
      const renewed = await repository.renewLease(leaseId);
      return { ...renewed, controlActions: await repository.listControlActionsForDevice(renewed.lease.deviceId) };
    });
  }

  async appendProgress(input: { runId: string; leaseId: string; seq: number; eventType: string; payload?: JsonRecord; retention?: RetentionMetadataInput }) {
    return await this.withRepository((repository) => repository.appendAgentletProgress(input));
  }

  async completeRun(input: { runId: string; leaseId: string; status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; result?: JsonRecord; error?: JsonRecord; metrics?: JsonRecord }) {
    return await this.withRepository((repository) => repository.completeRun(input));
  }

  private async mustDeviceIdFromLease(repository: PostgreSqlRepository, leaseId: string): Promise<string> {
    const lease: LeaseRecord | undefined = await repository.getLease(leaseId);
    if (!lease) throw new AgentlinkError(404, 'AL_LEASE_NOT_FOUND', 'Lease not found');
    return lease.deviceId;
  }

  private async withRepository<T>(work: (repository: PostgreSqlRepository) => Promise<T>): Promise<T> {
    return await this.runtime.withClient(async (client) => work(new PostgreSqlRepository(client, this.options)));
  }
}
