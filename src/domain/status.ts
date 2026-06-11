export const TASK_STATUSES = ['CREATED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED'] as const;
export const RUN_STATUSES = ['QUEUED', 'LEASED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
export const LEASE_STATUSES = ['ISSUED', 'ACKED', 'RENEWED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REJECTED'] as const;
export const DEVICE_STATUSES = ['REGISTERED', 'ONLINE', 'OFFLINE', 'SUSPENDED', 'REVOKED'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type LeaseStatus = (typeof LEASE_STATUSES)[number];
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const ACTIVE_LEASE_STATUSES = ['ISSUED', 'ACKED', 'RENEWED'] as const satisfies readonly LeaseStatus[];
export const TERMINAL_LEASE_STATUSES = ['COMPLETED', 'EXPIRED', 'CANCELLED', 'REJECTED'] as const satisfies readonly LeaseStatus[];
export const TERMINAL_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const satisfies readonly RunStatus[];
export const TERMINAL_TASK_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const satisfies readonly TaskStatus[];

export type LifecycleEvent =
  | 'create_task'
  | 'main_agent_accept'
  | 'agentlet_pull_lease'
  | 'agentlet_ack_accept'
  | 'agentlet_ack_reject'
  | 'lease_renew'
  | 'complete_success'
  | 'complete_failed_retryable'
  | 'complete_failed_terminal'
  | 'lease_expired_retryable'
  | 'lease_expired_terminal'
  | 'device_heartbeat_timeout'
  | 'device_revoke'
  | 'agentlet_recover_continue'
  | 'agentlet_recover_discard'
  | 'cancel_request'
  | 'policy_block';

export interface StateTransition {
  event: LifecycleEvent;
  task?: { from?: readonly TaskStatus[]; to: TaskStatus };
  run?: { from?: readonly RunStatus[]; to: RunStatus; createsNewAttempt?: boolean };
  lease?: { from?: readonly LeaseStatus[]; to: LeaseStatus };
  device?: { from?: readonly DeviceStatus[]; to: DeviceStatus };
}

export const STATE_TRANSITIONS: readonly StateTransition[] = [
  { event: 'create_task', task: { to: 'CREATED' } },
  { event: 'main_agent_accept', task: { from: ['CREATED'], to: 'QUEUED' }, run: { to: 'QUEUED' } },
  { event: 'agentlet_pull_lease', task: { from: ['QUEUED'], to: 'RUNNING' }, run: { from: ['QUEUED'], to: 'LEASED' }, lease: { to: 'ISSUED' }, device: { from: ['ONLINE'], to: 'ONLINE' } },
  { event: 'agentlet_ack_accept', run: { from: ['LEASED'], to: 'RUNNING' }, lease: { from: ['ISSUED'], to: 'ACKED' }, device: { from: ['ONLINE'], to: 'ONLINE' } },
  { event: 'agentlet_ack_reject', task: { from: ['RUNNING'], to: 'QUEUED' }, run: { from: ['LEASED'], to: 'QUEUED' }, lease: { from: ['ISSUED'], to: 'REJECTED' }, device: { from: ['ONLINE'], to: 'ONLINE' } },
  { event: 'lease_renew', run: { from: ['RUNNING'], to: 'RUNNING' }, lease: { from: ['ACKED', 'RENEWED'], to: 'RENEWED' }, device: { from: ['ONLINE'], to: 'ONLINE' } },
  { event: 'complete_success', task: { from: ['RUNNING'], to: 'SUCCEEDED' }, run: { from: ['RUNNING'], to: 'SUCCEEDED' }, lease: { from: ['ACKED', 'RENEWED'], to: 'COMPLETED' } },
  { event: 'complete_failed_retryable', task: { from: ['RUNNING'], to: 'QUEUED' }, run: { from: ['RUNNING'], to: 'FAILED', createsNewAttempt: true }, lease: { from: ['ACKED', 'RENEWED'], to: 'COMPLETED' } },
  { event: 'complete_failed_terminal', task: { from: ['RUNNING'], to: 'FAILED' }, run: { from: ['RUNNING'], to: 'FAILED' }, lease: { from: ['ACKED', 'RENEWED'], to: 'COMPLETED' } },
  { event: 'lease_expired_retryable', task: { from: ['RUNNING'], to: 'QUEUED' }, run: { from: ['LEASED', 'RUNNING'], to: 'TIMED_OUT', createsNewAttempt: true }, lease: { from: ACTIVE_LEASE_STATUSES, to: 'EXPIRED' } },
  { event: 'lease_expired_terminal', task: { from: ['RUNNING'], to: 'FAILED' }, run: { from: ['LEASED', 'RUNNING'], to: 'TIMED_OUT' }, lease: { from: ACTIVE_LEASE_STATUSES, to: 'EXPIRED' } },
  { event: 'device_heartbeat_timeout', run: { from: ['LEASED', 'RUNNING'], to: 'RUNNING' }, lease: { from: ACTIVE_LEASE_STATUSES, to: 'RENEWED' }, device: { from: ['ONLINE'], to: 'OFFLINE' } },
  { event: 'device_revoke', task: { from: ['QUEUED', 'RUNNING'], to: 'CANCELLED' }, run: { from: ['QUEUED', 'LEASED', 'RUNNING'], to: 'CANCELLED' }, lease: { from: ACTIVE_LEASE_STATUSES, to: 'CANCELLED' }, device: { from: ['REGISTERED', 'ONLINE', 'OFFLINE', 'SUSPENDED'], to: 'REVOKED' } },
  { event: 'agentlet_recover_continue', run: { from: ['RUNNING'], to: 'RUNNING' }, lease: { from: ['ACKED', 'RENEWED'], to: 'RENEWED' }, device: { from: ['OFFLINE'], to: 'ONLINE' } },
  { event: 'agentlet_recover_discard', task: { from: ['RUNNING'], to: 'QUEUED' }, run: { from: ['LEASED', 'RUNNING'], to: 'TIMED_OUT', createsNewAttempt: true }, lease: { from: ACTIVE_LEASE_STATUSES, to: 'EXPIRED' }, device: { from: ['OFFLINE'], to: 'ONLINE' } },
  { event: 'cancel_request', task: { from: ['QUEUED', 'RUNNING'], to: 'CANCELLED' }, run: { from: ['QUEUED', 'LEASED', 'RUNNING'], to: 'CANCELLED' }, lease: { from: ACTIVE_LEASE_STATUSES, to: 'CANCELLED' } },
  { event: 'policy_block', task: { from: ['CREATED', 'QUEUED'], to: 'BLOCKED' }, run: { from: ['QUEUED'], to: 'FAILED' } },
];

const ACTIVE_LEASE_STATUS_SET: ReadonlySet<LeaseStatus> = new Set(ACTIVE_LEASE_STATUSES);
const TERMINAL_RUN_STATUS_SET: ReadonlySet<RunStatus> = new Set(TERMINAL_RUN_STATUSES);

export function isActiveLeaseStatus(status: LeaseStatus): boolean {
  return ACTIVE_LEASE_STATUS_SET.has(status);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUS_SET.has(status);
}

export function shouldCreateNewRunAttempt(event: LifecycleEvent): boolean {
  return STATE_TRANSITIONS.some((transition) => transition.event === event && transition.run?.createsNewAttempt === true);
}
