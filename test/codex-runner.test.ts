import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexCliRunnerAdapter, assertWorkspaceAllowed, buildLocalRunnerEnv, runnerInputFromInstruction, type CommandRunner } from '../src/agentlet/codex-runner.js';
import { RunnerAdapterError, runnerEventToAgentletProgress, type RunnerEvent } from '../src/agentlet/runner.js';

const workspace = process.cwd();

function input() {
  return runnerInputFromInstruction({
    runId: 'run_1',
    taskId: 'task_1',
    leaseId: 'lease_1',
    instruction: { prompt: 'inspect repo', workspace },
  });
}

test('Codex adapter builds a bounded codex exec command', () => {
  const adapter = new CodexCliRunnerAdapter({
    command: 'codex-test',
    model: 'test-model',
    profile: 'm1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    extraArgs: ['--ephemeral'],
    allowedWorkspaceRoots: [workspace],
    envAllowlist: ['PATH'],
    envOverrides: { AGENTLINK_TEST: '1' },
  });

  const command = adapter.buildCommand(input());
  assert.equal(command.command, 'codex-test');
  assert.deepEqual(command.args, [
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--cd',
    workspace,
    '--sandbox',
    'read-only',
    '--model',
    'test-model',
    '--profile',
    'm1',
    '--ephemeral',
    'inspect repo',
  ]);
  assert.equal(command.cwd, workspace);
  assert.equal(command.env.AGENTLINK_TEST, '1');
  assert.equal(command.env.OPENAI_API_KEY, undefined);
});

test('Codex adapter rejects relative, unconfigured, or outside workspaces', () => {
  assert.throws(
    () => assertWorkspaceAllowed(workspace),
    (error) => error instanceof RunnerAdapterError && error.code === 'AL_RUNNER_WORKSPACE_DENIED',
  );
  assert.throws(
    () => assertWorkspaceAllowed('relative/path', [workspace]),
    (error) => error instanceof RunnerAdapterError && error.code === 'AL_RUNNER_WORKSPACE_DENIED',
  );
  assert.throws(
    () => assertWorkspaceAllowed('/tmp/not-agentlink', [workspace]),
    (error) => error instanceof RunnerAdapterError && error.code === 'AL_RUNNER_WORKSPACE_DENIED',
  );
  assert.equal(assertWorkspaceAllowed(`${workspace}/src`, [workspace]), `${workspace}/src`);
});

test('Codex adapter maps stdout stderr and success into ordered runner progress', async () => {
  const commandRunner: CommandRunner = async (command) => {
    command.onStdout?.('hello\n');
    command.onStderr?.('warn\n');
    return { exitCode: 0, startedAt: '2026-06-12T00:00:00.000Z', finishedAt: '2026-06-12T00:00:01.000Z' };
  };
  const adapter = new CodexCliRunnerAdapter({ commandRunner, allowedWorkspaceRoots: [workspace], now: fixedClock() });
  const events: RunnerEvent[] = [];
  const result = await adapter.run(input(), { onEvent: (event) => events.push(event) });

  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(events.map((event) => [event.seq, event.eventType]), [
    [1, 'LIFECYCLE'],
    [2, 'STDOUT'],
    [3, 'STDERR'],
    [4, 'FINAL'],
  ]);
  assert.deepEqual(runnerEventToAgentletProgress(events[1]!), {
    runId: 'run_1',
    leaseId: 'lease_1',
    seq: 2,
    eventType: 'STDOUT',
    payload: { text: 'hello\n' },
  });
});

test('Codex adapter returns retryable failure for non-zero exit', async () => {
  const adapter = new CodexCliRunnerAdapter({
    allowedWorkspaceRoots: [workspace],
    commandRunner: async (command) => {
      command.onStderr?.('boom');
      return { exitCode: 2, startedAt: '2026-06-12T00:00:00.000Z', finishedAt: '2026-06-12T00:00:01.000Z' };
    },
  });
  const events: RunnerEvent[] = [];
  const result = await adapter.run(input(), { onEvent: (event) => events.push(event) });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.error?.code, 'AL_RUNNER_EXIT_NONZERO');
  assert.equal(result.error?.retryable, true);
  assert.equal(events.at(-1)?.eventType, 'FINAL');
  assert.equal(events.some((event) => event.eventType === 'ERROR'), true);
});

test('Codex adapter maps AbortSignal cancellation to CANCELLED', async () => {
  let capturedSignal: AbortSignal | undefined;
  const abort = new AbortController();
  const commandRunner: CommandRunner = async (command) => {
    capturedSignal = command.signal;
    abort.abort();
    return { exitCode: null, signal: 'SIGTERM', startedAt: '2026-06-12T00:00:00.000Z', finishedAt: '2026-06-12T00:00:01.000Z' };
  };
  const adapter = new CodexCliRunnerAdapter({ commandRunner, allowedWorkspaceRoots: [workspace] });

  const result = await adapter.run(input(), { signal: abort.signal });
  assert.equal(capturedSignal?.aborted, true);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.error?.code, 'AL_RUNNER_CANCELLED');
});

test('Codex adapter maps local timeout to retryable FAILED result', async () => {
  const commandRunner: CommandRunner = async (command) => {
    await new Promise<void>((resolve) => command.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return { exitCode: null, signal: 'SIGTERM', startedAt: '2026-06-12T00:00:00.000Z', finishedAt: '2026-06-12T00:00:01.000Z' };
  };
  const adapter = new CodexCliRunnerAdapter({ commandRunner, allowedWorkspaceRoots: [workspace], timeoutMs: 1 });
  const result = await adapter.run(input());
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error?.code, 'AL_RUNNER_TIMEOUT');
  assert.equal(result.error?.retryable, true);
});

test('local runner env only copies allowlisted keys and explicit overrides', () => {
  const env = buildLocalRunnerEnv({ PATH: '/bin', OPENAI_API_KEY: 'secret' }, ['PATH'], { CODEX_HOME: '/tmp/codex-home' });
  assert.deepEqual(env, { PATH: '/bin', CODEX_HOME: '/tmp/codex-home' });
});

function fixedClock(): () => Date {
  let offset = 0;
  return () => new Date(Date.parse('2026-06-12T00:00:00.000Z') + offset++);
}
