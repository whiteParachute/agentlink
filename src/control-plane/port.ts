import type { ControlActionRecord, DeviceRecord, LeaseRecord, RecoverDecision, RecoverableRunRecord, RunEventRecord, RunRecord, TaskRecord } from '../domain/entities.js';
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
  appendProgress(input: { runId: string; leaseId: string; seq: number; eventType: string; payload?: Record<string, unknown> }): MaybePromise<RunEventRecord>;
  completeRun(input: {
    runId: string;
    leaseId: string;
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
  }): MaybePromise<{ run: RunRecord; task: TaskRecord; lease: LeaseRecord }>;
}
