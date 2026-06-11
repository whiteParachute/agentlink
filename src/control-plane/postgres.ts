import { AgentlinkError } from './errors.js';
import type { AgentlinkControlPlanePort } from './port.js';
import type { AgentletInstruction, CreateTaskInput, PullInput, RegisterDeviceInput } from './in-memory.js';
import type { JsonRecord, LeaseRecord } from '../domain/entities.js';
import { PostgreSqlRepository } from '../db/postgres-repository.js';
import { PgRuntime } from '../db/pg-client.js';

export interface PostgresControlPlaneOptions {
  leaseTtlMs?: number;
  now?: () => Date;
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

  async ackLease(leaseId: string, accepted: boolean, reason?: string) {
    return await this.withRepository(async (repository) => {
      const deviceId = await this.mustDeviceIdFromLease(repository, leaseId);
      return accepted ? await repository.ackLeaseAccepted(leaseId, deviceId) : await repository.ackLeaseRejected(leaseId, deviceId, reason);
    });
  }

  async appendProgress(input: { runId: string; leaseId: string; seq: number; eventType: string; payload?: JsonRecord }) {
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
