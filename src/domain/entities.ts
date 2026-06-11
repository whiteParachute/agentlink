import type { DeviceStatus, LeaseStatus, RunStatus, TaskStatus } from './status.js';

export type Domain = 'personal' | 'work';
export type JsonRecord = Record<string, unknown>;

export interface TaskRecord {
  id: string;
  domain: Domain;
  source: string;
  sourceRef: string;
  payload: JsonRecord;
  taskSpec: JsonRecord;
  status: TaskStatus;
  currentRunId: string;
  retryCount: number;
  maxRetries: number;
  idempotencyKey: string;
  idempotencySignature: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  domain: Domain;
  status: RunStatus;
  attemptNo: number;
  instruction: JsonRecord;
  retryOfRunId?: string;
  currentLeaseId?: string;
  policyDecisionId?: string;
  result?: JsonRecord;
  error?: JsonRecord;
  metrics: JsonRecord;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
}

export interface DeviceRecord {
  id: string;
  domain: Domain;
  displayName: string;
  tokenHash: string;
  networkScope: string;
  ownerUserId: string;
  trustLevel: 'untrusted' | 'standard' | 'trusted';
  status: DeviceStatus;
  agentletVersion?: string;
  lastAuthAt?: string;
  lastHeartbeatAt?: string;
  revokedAt?: string;
  metadata: JsonRecord;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerRecord {
  id: string;
  deviceId: string;
  runnerType: string;
  runnerVersion?: string;
  model?: string;
  status: 'online' | 'offline' | 'disabled';
  maxConcurrency: number;
  capabilities: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityGrantRecord {
  id: string;
  domain: Domain;
  deviceId: string;
  runnerId: string;
  capability: string;
  grantStatus: 'GRANTED' | 'REVOKED';
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
}

export type WorkdirAccessMode = 'read' | 'write' | 'read_write';

export interface WorkdirGrantRecord {
  id: string;
  domain: Domain;
  deviceId: string;
  pathPrefix: string;
  accessMode: WorkdirAccessMode;
  createdAt: string;
  revokedAt?: string;
}

export interface PolicyDecisionRecord {
  id: string;
  domain: Domain;
  taskId?: string;
  runId?: string;
  deviceId?: string;
  runnerId?: string;
  input: JsonRecord;
  decision: 'ALLOW' | 'DENY';
  reason?: string;
  createdAt: string;
}

export interface LeaseRecord {
  id: string;
  runId: string;
  domain: Domain;
  deviceId: string;
  runnerId: string;
  status: LeaseStatus;
  issuedAt: string;
  expiresAt: string;
  ackedAt?: string;
  renewedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  expireReason?: string;
  terminalPayloadHash?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// M1 run events are the agentlet progress stream only. Lifecycle/system audit events
// must use a separate stream/table before they are implemented, so agentlet seq stays unambiguous.
export interface RunEventRecord {
  runId: string;
  seq: number;
  domain: Domain;
  eventType: string;
  payload: JsonRecord;
  emittedAt: string;
}

export interface ControlActionRecord {
  type: 'cancel_run';
  runId: string;
  leaseId: string;
  reason: string;
}

export interface RecoverableRunRecord {
  runId: string;
  taskId: string;
  leaseId: string;
  runStatus: RunStatus;
  leaseStatus: LeaseStatus;
  instruction: JsonRecord;
  expiresAt: string;
}
