import type { DeviceRecord, LeaseRecord, RunEventRecord, RunRecord, TaskRecord } from '../domain/entities.js';
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
  ackLease(leaseId: string, accepted: boolean, reason?: string): MaybePromise<{ lease: LeaseRecord; run: RunRecord; task: TaskRecord }>;
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
