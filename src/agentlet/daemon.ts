import type { AgentlinkControlPlanePort } from '../control-plane/port.js';
import type { RunRecord, TaskRecord } from '../domain/entities.js';
import {
  runnerEventToAgentletProgress,
  type RunnerAdapter,
  type RunnerEvent,
  type RunnerResult,
} from './runner.js';
import { runnerInputFromInstruction } from './codex-runner.js';

// Minimal, test-drivable agentlet consume step (AL-M1-014). It reuses the
// existing agentlet pull/ack/progress/complete control-plane surface plus a
// RunnerAdapter to consume exactly one queued run into a terminal state. It is
// deliberately not a long-running production daemon: callers (or tests) invoke
// daemonStep repeatedly to drive a loop.
export interface DaemonStepDeps {
  controlPlane: AgentlinkControlPlanePort;
  runner: RunnerAdapter;
}

export interface DaemonStepInput {
  deviceId: string;
  runnerId: string;
  supportedCapabilities?: readonly string[];
}

export type DaemonStepOutcome =
  | { kind: 'idle' }
  | { kind: 'completed'; task: TaskRecord; run: RunRecord; result: RunnerResult }
  | { kind: 'failed'; task: TaskRecord; run: RunRecord; result: RunnerResult }
  | { kind: 'cancelled'; task: TaskRecord; run: RunRecord; result: RunnerResult };

export async function daemonStep(deps: DaemonStepDeps, input: DaemonStepInput): Promise<DaemonStepOutcome> {
  const { controlPlane, runner } = deps;
  const instruction = await controlPlane.pull({
    deviceId: input.deviceId,
    runnerId: input.runnerId,
    ...(input.supportedCapabilities ? { supportedCapabilities: input.supportedCapabilities } : {}),
  });
  if (!instruction) return { kind: 'idle' };

  // Accept the lease so progress/complete are allowed by the state machine.
  await controlPlane.ackLease(instruction.leaseId, true);

  const runInput = runnerInputFromInstruction({
    runId: instruction.runId,
    taskId: instruction.taskId,
    leaseId: instruction.leaseId,
    instruction: instruction.instruction,
    ...(instruction.expiresAt ? { deadlineAt: instruction.expiresAt } : {}),
  });

  // Buffer events so we never abandon a held lease if onEvent throws mid-run.
  const events: RunnerEvent[] = [];
  let result: RunnerResult;
  try {
    result = await runner.run(runInput, { onEvent: (event) => events.push(event) });
  } catch (error) {
    // Runner threw: drive the run to a terminal FAILED state instead of leaving
    // the lease dangling. A completeRun failure is surfaced to the caller.
    const failure: RunnerResult = {
      status: 'FAILED',
      error: { code: 'AL_RUNNER_THREW', message: error instanceof Error ? error.message : String(error) },
      metrics: {},
    };
    const completion = await complete(controlPlane, instruction.runId, instruction.leaseId, failure);
    return { kind: 'failed', task: completion.task, run: completion.run, result: failure };
  }

  for (const event of events) {
    const progress = runnerEventToAgentletProgress(event);
    await controlPlane.appendProgress({
      runId: progress.runId,
      leaseId: progress.leaseId,
      seq: progress.seq,
      eventType: progress.eventType,
      payload: progress.payload,
    });
  }

  const completion = await complete(controlPlane, instruction.runId, instruction.leaseId, result);
  if (result.status === 'SUCCEEDED') return { kind: 'completed', task: completion.task, run: completion.run, result };
  if (result.status === 'CANCELLED') return { kind: 'cancelled', task: completion.task, run: completion.run, result };
  return { kind: 'failed', task: completion.task, run: completion.run, result };
}

async function complete(
  controlPlane: AgentlinkControlPlanePort,
  runId: string,
  leaseId: string,
  result: RunnerResult,
): Promise<{ run: RunRecord; task: TaskRecord }> {
  const completion = await controlPlane.completeRun({
    runId,
    leaseId,
    status: result.status,
    ...(result.result ? { result: result.result } : {}),
    ...(result.error ? { error: result.error } : {}),
    metrics: result.metrics,
  });
  return { run: completion.run, task: completion.task };
}
