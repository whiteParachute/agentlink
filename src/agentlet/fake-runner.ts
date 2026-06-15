import type { JsonRecord } from '../domain/entities.js';
import type {
  RunnerAdapter,
  RunnerEvent,
  RunnerResult,
  RunnerRunInput,
  RunnerRunOptions,
  RunnerTerminalStatus,
} from './runner.js';

// A deterministic, dependency-free RunnerAdapter for tests and dry-runs
// (AL-M1-014). It emits a configurable list of events and a terminal result
// without spawning any real process. It never executes Codex or any command.
export interface FakeRunnerStepEvent {
  eventType: RunnerEvent['eventType'];
  payload?: JsonRecord;
}

export interface FakeRunnerScript {
  status: RunnerTerminalStatus;
  events?: readonly FakeRunnerStepEvent[];
  result?: JsonRecord;
  error?: JsonRecord;
  metrics?: JsonRecord;
  throwError?: Error;
}

export class FakeRunnerAdapter implements RunnerAdapter {
  readonly runnerType = 'fake';

  constructor(private readonly script: FakeRunnerScript, private readonly now: () => Date = () => new Date()) {}

  async run(input: RunnerRunInput, options?: RunnerRunOptions): Promise<RunnerResult> {
    if (this.script.throwError) throw this.script.throwError;
    const events = this.script.events ?? [];
    events.forEach((step, index) => {
      const event: RunnerEvent = {
        runId: input.runId,
        leaseId: input.leaseId,
        seq: index + 1,
        eventType: step.eventType,
        payload: step.payload ?? {},
        emittedAt: this.now().toISOString(),
      };
      options?.onEvent?.(event);
    });
    return {
      status: this.script.status,
      ...(this.script.result ? { result: this.script.result } : {}),
      ...(this.script.error ? { error: this.script.error } : {}),
      metrics: this.script.metrics ?? {},
    };
  }
}
