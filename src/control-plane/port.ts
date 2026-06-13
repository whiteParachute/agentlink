import type {
  CapabilityGrantRecord,
  ChannelUserRecord,
  ControlActionRecord,
  DeviceRecord,
  LeaseRecord,
  MainUserRecord,
  PlatformIdentityRecord,
  RecoverDecision,
  RecoverableRunRecord,
  RunEventRecord,
  RunRecord,
  TaskRecord,
  WorkdirAccessMode,
  WorkdirGrantRecord,
} from '../domain/entities.js';
import type { RetentionMetadataInput } from '../domain/retention.js';
import type {
  AgentletInstruction,
  CreateTaskInput,
  CreateTaskResult,
  PullInput,
  RegisterDeviceInput,
  RegisterDeviceResult,
} from './in-memory.js';

export type MaybePromise<T> = T | Promise<T>;

export interface AgentlinkControlPlanePort {
  createTask(input: CreateTaskInput, idempotencyKey: string): MaybePromise<CreateTaskResult>;
  getTask(taskId: string): MaybePromise<TaskRecord | undefined>;
  getRun(runId: string): MaybePromise<RunRecord | undefined>;
  getLease(leaseId: string): MaybePromise<LeaseRecord | undefined>;
  getRunEvents(runId: string, afterSeq?: number): MaybePromise<RunEventRecord[]>;
  registerDevice(input: RegisterDeviceInput): MaybePromise<RegisterDeviceResult>;
  listCapabilityGrants(deviceId: string): MaybePromise<CapabilityGrantRecord[]>;
  grantCapability(input: { deviceId: string; runnerId: string; capability: string; grantedBy: string }): MaybePromise<CapabilityGrantRecord>;
  revokeCapabilityGrant(grantId: string): MaybePromise<CapabilityGrantRecord>;
  listWorkdirGrants(deviceId: string): MaybePromise<WorkdirGrantRecord[]>;
  grantWorkdir(input: { deviceId: string; pathPrefix: string; accessMode?: WorkdirAccessMode }): MaybePromise<WorkdirGrantRecord>;
  revokeWorkdirGrant(grantId: string): MaybePromise<WorkdirGrantRecord>;
  revokeDevice(deviceId: string, reason?: string): MaybePromise<{ device: DeviceRecord; tasks: TaskRecord[]; runs: RunRecord[]; leases: LeaseRecord[] }>;
  heartbeat(deviceId: string, deviceSecret: string): MaybePromise<DeviceRecord>;
  authenticateDevice(deviceId: string, deviceSecret: string): MaybePromise<DeviceRecord>;
  pull(input: PullInput): MaybePromise<AgentletInstruction | undefined>;
  cancelTask(taskId: string, reason?: string): MaybePromise<{ task: TaskRecord; run?: RunRecord; lease?: LeaseRecord; controlActions: ControlActionRecord[] }>;
  pollControl(deviceId: string): MaybePromise<{ controlActions: ControlActionRecord[] }>;
  ackControlAction(deviceId: string, actionId: string): MaybePromise<{ controlAction: ControlActionRecord }>;
  recoverDevice(deviceId: string): MaybePromise<{ recoverableRuns: RecoverableRunRecord[] }>;
  decideRecovery(input: { deviceId: string; leaseId: string; decision: RecoverDecision; reason?: string }): MaybePromise<{ decision: RecoverDecision; lease: LeaseRecord; run: RunRecord; task: TaskRecord; retryRun?: RunRecord }>;
  ackLease(leaseId: string, accepted: boolean, reason?: string): MaybePromise<{ lease: LeaseRecord; run: RunRecord; task: TaskRecord }>;
  renewLease(leaseId: string): MaybePromise<{ lease: LeaseRecord; run: RunRecord; task: TaskRecord; controlActions: ControlActionRecord[] }>;
  appendProgress(input: { runId: string; leaseId: string; seq: number; eventType: string; payload?: Record<string, unknown>; retention?: RetentionMetadataInput }): MaybePromise<RunEventRecord>;
  completeRun(input: {
    runId: string;
    leaseId: string;
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
  }): MaybePromise<{ run: RunRecord; task: TaskRecord; lease: LeaseRecord }>;
  getMainUserProfile(): MaybePromise<MainUserRecord | undefined>;
  upsertMainUserProfile(input: {
    displayName?: string;
    locale?: string;
    timezone?: string;
    metadata?: Record<string, unknown>;
    retention?: RetentionMetadataInput;
  }): MaybePromise<{ mainUser: MainUserRecord; created: boolean }>;
  upsertChannelUser(input: {
    platform: string;
    externalId: string;
    displayName?: string;
    channelUserMetadata?: Record<string, unknown>;
    platformIdentityMetadata?: Record<string, unknown>;
    retention?: RetentionMetadataInput;
  }): MaybePromise<{ channelUser: ChannelUserRecord; platformIdentity: PlatformIdentityRecord; created: boolean }>;
  setChannelUserCategory(input: { channelUserId: string; category: string }): MaybePromise<{ channelUser: ChannelUserRecord }>;
  resolvePlatformIdentity(input: { platform: string; externalId: string }): MaybePromise<{ channelUser: ChannelUserRecord; platformIdentity: PlatformIdentityRecord } | undefined>;
}
