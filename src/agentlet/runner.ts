import type { JsonRecord } from '../domain/entities.js';

export type RunnerTerminalStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type RunnerEventType = 'LIFECYCLE' | 'STDOUT' | 'STDERR' | 'ERROR' | 'FINAL';

export interface RunnerRunInput {
  runId: string;
  taskId: string;
  leaseId: string;
  instruction: JsonRecord;
  prompt: string;
  workspace: string;
  deadlineAt?: string;
}

export interface RunnerEvent {
  runId: string;
  leaseId: string;
  seq: number;
  eventType: RunnerEventType;
  payload: JsonRecord;
  emittedAt: string;
}

export interface RunnerResult {
  status: RunnerTerminalStatus;
  result?: JsonRecord;
  error?: JsonRecord;
  metrics: JsonRecord;
}

export interface RunnerRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: RunnerEvent) => void;
}

export interface RunnerAdapter {
  readonly runnerType: string;
  run(input: RunnerRunInput, options?: RunnerRunOptions): Promise<RunnerResult>;
}

export interface AgentletProgressInput {
  runId: string;
  leaseId: string;
  seq: number;
  eventType: RunnerEventType;
  payload: JsonRecord;
}

export function runnerEventToAgentletProgress(event: RunnerEvent): AgentletProgressInput {
  return {
    runId: event.runId,
    leaseId: event.leaseId,
    seq: event.seq,
    eventType: event.eventType,
    payload: event.payload,
  };
}

export function requireInstructionString(instruction: JsonRecord, key: string, fallback?: string): string {
  const value = instruction[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new RunnerAdapterError('AL_RUNNER_BAD_INSTRUCTION', `Instruction field ${key} must be a non-empty string`);
}

export class RunnerAdapterError extends Error {
  constructor(
    readonly code: 'AL_RUNNER_BAD_INSTRUCTION' | 'AL_RUNNER_WORKSPACE_DENIED' | 'AL_RUNNER_COMMAND_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'RunnerAdapterError';
  }
}
