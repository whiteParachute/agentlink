import type { RetentionClass, Sensitivity } from './retention.js';
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
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
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
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
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
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  emittedAt: string;
}

// AL-M1-002: artifact / audit retention metadata types. These objects have no
// writer API in M1; the types and schema-level defaults/invariants document the
// retention boundary so later slices can wire writers without redefining it.
export interface ArtifactRecord {
  domain: Domain;
  hash: string;
  kind: string;
  size: number;
  storageType: 'inline' | 'ref';
  uri?: string;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
}

export interface AuditLogRecord {
  id: string;
  domain: Domain;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  result: string;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
}

export interface ControlActionRecord {
  id: string;
  type: 'cancel_run';
  deviceId: string;
  runId: string;
  leaseId: string;
  reason: string;
  status: 'PENDING' | 'ACKED';
  createdAt: string;
  acknowledgedAt?: string;
  updatedAt: string;
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

export type RecoverDecision = 'continue' | 'discard';

export interface MainUserRecord {
  id: 'main';
  displayName: string;
  locale: string;
  timezone: string;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelUserRecord {
  id: string;
  displayName: string;
  category: string;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformIdentityRecord {
  id: string;
  channelUserId: string;
  platform: string;
  externalId: string;
  normalizedExternalId: string;
  displayName: string;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
}

export type ReplyMode = 'thread' | 'dialog';

export interface GroupProfileRecord {
  id: string;
  platform: string;
  externalGroupId: string;
  normalizedExternalGroupId: string;
  displayName: string;
  groupType: string;
  tone: string;
  defaultReplyMode: ReplyMode;
  contextScope: string;
  memoryScope: string;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
}

export type SessionScope = 'large' | 'small';

export interface SessionRecord {
  id: string;
  sessionScope: SessionScope;
  platform?: string;
  externalChatId?: string;
  externalThreadId?: string;
  parentSessionId?: string;
  groupProfileId?: string;
  naturalKey: string;
  displayName: string;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
}


export type MemoryCandidateStatus = 'pending' | 'accepted' | 'rejected';

export interface MemoryCandidateRecord {
  id: string;
  sessionId: string;
  entryId?: string;
  sourceEventId?: string;
  candidateText: string;
  status: MemoryCandidateStatus;
  reason: string;
  confidence?: number;
  naturalKey: string;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
}

export interface GroupContextProjection {
  groupProfile: GroupProfileRecord;
  platform: string;
  externalGroupId: string;
  defaultReplyMode: ReplyMode;
  contextScope: string;
  memoryScope: string;
  tone: string;
}

export interface SourceEventRecord {
  id: string;
  sourceSystem: string;
  sourceRef: string;
  sourceHash: string;
  eventType: string;
  platform?: string;
  occurredAt: string;
  receivedAt: string;
  payload: JsonRecord;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
}

export type EntryType = 'dm' | 'group' | 'thread' | 'web' | 'unknown';

export interface EntryRecord {
  id: string;
  sourceEventId: string;
  entryType: EntryType;
  platform?: string;
  externalChatId?: string;
  externalThreadId?: string;
  externalMessageId?: string;
  speakerChannelUserId?: string;
  groupProfileId?: string;
  sessionId?: string;
  agentMentioned: boolean;
  bodyText: string;
  metadata: JsonRecord;
  retentionClass: RetentionClass;
  memorySpace: string;
  sourceSystem: string;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
}
