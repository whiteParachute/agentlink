import { spawn } from 'node:child_process';
import { isAbsolute, resolve, sep } from 'node:path';
import type { JsonRecord } from '../domain/entities.js';
import { requireInstructionString, RunnerAdapterError, type RunnerAdapter, type RunnerEvent, type RunnerRunInput, type RunnerRunOptions, type RunnerResult } from './runner.js';

export interface CommandRunInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface CommandRunResult {
  exitCode: number | null;
  signal?: string;
  startedAt: string;
  finishedAt: string;
}

export type CommandRunner = (input: CommandRunInput) => Promise<CommandRunResult>;

export interface CodexRunnerAdapterOptions {
  command?: string;
  model?: string;
  profile?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  extraArgs?: readonly string[];
  envAllowlist?: readonly string[];
  envOverrides?: NodeJS.ProcessEnv;
  allowedWorkspaceRoots?: readonly string[];
  timeoutMs?: number;
  now?: () => Date;
  commandRunner?: CommandRunner;
}

export interface CodexCommandSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_ENV_ALLOWLIST = ['PATH', 'HOME', 'CODEX_HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'] as const;

export class CodexCliRunnerAdapter implements RunnerAdapter {
  readonly runnerType = 'codex_cli';
  private readonly command: string;
  private readonly model: string | undefined;
  private readonly profile: string | undefined;
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  private readonly approvalPolicy: 'never' | 'on-request' | 'untrusted';
  private readonly extraArgs: readonly string[];
  private readonly envAllowlist: readonly string[];
  private readonly envOverrides: NodeJS.ProcessEnv;
  private readonly allowedWorkspaceRoots: readonly string[];
  private readonly timeoutMs: number | undefined;
  private readonly now: () => Date;
  private readonly commandRunner: CommandRunner;

  constructor(options: CodexRunnerAdapterOptions = {}) {
    this.command = options.command ?? 'codex';
    this.model = options.model;
    this.profile = options.profile;
    this.sandbox = options.sandbox ?? 'workspace-write';
    this.approvalPolicy = options.approvalPolicy ?? 'never';
    this.extraArgs = options.extraArgs ?? [];
    this.envAllowlist = options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST;
    this.envOverrides = options.envOverrides ?? {};
    this.allowedWorkspaceRoots = options.allowedWorkspaceRoots ?? [];
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? (() => new Date());
    this.commandRunner = options.commandRunner ?? spawnCommandRunner;
  }

  buildCommand(input: RunnerRunInput): CodexCommandSpec {
    const workspace = assertWorkspaceAllowed(input.workspace, this.allowedWorkspaceRoots);
    const prompt = requireInstructionString(input.instruction, 'prompt', input.prompt);
    // `--ask-for-approval` is a top-level Codex CLI option in codex-cli 0.138.0;
    // keep it before the `exec` subcommand so the generated command is accepted by the local CLI.
    const args: string[] = ['--ask-for-approval', this.approvalPolicy, 'exec', '--json', '--cd', workspace, '--sandbox', this.sandbox];
    if (this.model) args.push('--model', this.model);
    if (this.profile) args.push('--profile', this.profile);
    args.push(...this.extraArgs, prompt);
    return {
      command: this.command,
      args,
      cwd: workspace,
      env: buildLocalRunnerEnv(process.env, this.envAllowlist, this.envOverrides),
    };
  }

  async run(input: RunnerRunInput, options: RunnerRunOptions = {}): Promise<RunnerResult> {
    const command = this.buildCommand(input);
    let seq = 0;
    const startedAt = this.now().toISOString();
    const emit = (eventType: RunnerEvent['eventType'], payload: JsonRecord): void => {
      seq += 1;
      options.onEvent?.({ runId: input.runId, leaseId: input.leaseId, seq, eventType, payload, emittedAt: this.now().toISOString() });
    };

    let abortReason: 'external' | 'timeout' | undefined;
    const linkedAbort = createLinkedAbortController(options.signal, () => {
      abortReason = 'external';
    });
    const abortController = linkedAbort.controller;
    const timeout = this.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          abortReason = 'timeout';
          abortController.abort();
        }, this.timeoutMs);

    emit('LIFECYCLE', { state: 'started', runner_type: this.runnerType, command: command.command, args: redactPromptArg(command.args), cwd: command.cwd });

    if (abortController.signal.aborted) {
      const metrics = { started_at: startedAt, finished_at: this.now().toISOString() };
      const error = { code: 'AL_RUNNER_CANCELLED', message: 'Codex runner was cancelled before start', retryable: false };
      emit('FINAL', { status: 'CANCELLED', error, metrics });
      if (timeout) clearTimeout(timeout);
      linkedAbort.dispose();
      return { status: 'CANCELLED', error, metrics };
    }

    try {
      const result = await this.commandRunner({
        ...command,
        signal: abortController.signal,
        onStdout: (chunk) => emit('STDOUT', { text: chunk }),
        onStderr: (chunk) => emit('STDERR', { text: chunk }),
      });
      const finishedAt = this.now().toISOString();
      const metrics = { started_at: startedAt, finished_at: finishedAt, exit_code: result.exitCode, signal: result.signal ?? null };

      if (abortReason || abortController.signal.aborted) {
        const reason = abortReason ?? 'external';
        const error = { code: reason === 'timeout' ? 'AL_RUNNER_TIMEOUT' : 'AL_RUNNER_CANCELLED', message: reason === 'timeout' ? 'Codex runner timed out' : 'Codex runner was cancelled', retryable: reason === 'timeout' };
        emit('FINAL', { status: reason === 'timeout' ? 'FAILED' : 'CANCELLED', error, metrics });
        return { status: reason === 'timeout' ? 'FAILED' : 'CANCELLED', error, metrics };
      }

      if (result.exitCode === 0) {
        const success = { text: 'Codex CLI completed successfully', exit_code: 0 };
        emit('FINAL', { status: 'SUCCEEDED', result: success, metrics });
        return { status: 'SUCCEEDED', result: success, metrics };
      }

      const error = { code: 'AL_RUNNER_EXIT_NONZERO', message: `Codex CLI exited with code ${String(result.exitCode)}`, exit_code: result.exitCode, retryable: true };
      emit('ERROR', error);
      emit('FINAL', { status: 'FAILED', error, metrics });
      return { status: 'FAILED', error, metrics };
    } catch (error) {
      const finishedAt = this.now().toISOString();
      const metrics = { started_at: startedAt, finished_at: finishedAt };
      if (abortReason || abortController.signal.aborted) {
        const reason = abortReason ?? 'external';
        const payload = { code: reason === 'timeout' ? 'AL_RUNNER_TIMEOUT' : 'AL_RUNNER_CANCELLED', message: reason === 'timeout' ? 'Codex runner timed out' : 'Codex runner was cancelled', retryable: reason === 'timeout' };
        emit('FINAL', { status: reason === 'timeout' ? 'FAILED' : 'CANCELLED', error: payload, metrics });
        return { status: reason === 'timeout' ? 'FAILED' : 'CANCELLED', error: payload, metrics };
      }
      const payload = { code: 'AL_RUNNER_COMMAND_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true };
      emit('ERROR', payload);
      emit('FINAL', { status: 'FAILED', error: payload, metrics });
      return { status: 'FAILED', error: payload, metrics };
    } finally {
      if (timeout) clearTimeout(timeout);
      linkedAbort.dispose();
    }
  }
}

export function runnerInputFromInstruction(input: { runId: string; taskId: string; leaseId: string; instruction: JsonRecord; deadlineAt?: string }): RunnerRunInput {
  const prompt = requireInstructionString(input.instruction, 'prompt', '');
  const workspace = requireInstructionString(input.instruction, 'workspace');
  const runInput: RunnerRunInput = {
    runId: input.runId,
    taskId: input.taskId,
    leaseId: input.leaseId,
    instruction: input.instruction,
    prompt,
    workspace,
  };
  if (input.deadlineAt !== undefined) runInput.deadlineAt = input.deadlineAt;
  return runInput;
}

export function assertWorkspaceAllowed(workspace: string, allowedRoots: readonly string[] = []): string {
  if (!isAbsolute(workspace)) {
    throw new RunnerAdapterError('AL_RUNNER_WORKSPACE_DENIED', 'Workspace must be an absolute path');
  }
  const resolvedWorkspace = resolve(workspace);
  if (allowedRoots.length === 0) {
    throw new RunnerAdapterError('AL_RUNNER_WORKSPACE_DENIED', 'At least one allowed workspace root is required');
  }
  const allowed = allowedRoots.some((root) => {
    if (!isAbsolute(root)) return false;
    const resolvedRoot = resolve(root);
    return resolvedWorkspace === resolvedRoot || resolvedWorkspace.startsWith(`${resolvedRoot}${sep}`);
  });
  if (!allowed) {
    throw new RunnerAdapterError('AL_RUNNER_WORKSPACE_DENIED', 'Workspace is outside allowed workspace roots');
  }
  return resolvedWorkspace;
}

export function buildLocalRunnerEnv(source: NodeJS.ProcessEnv, allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function spawnCommandRunner(input: CommandRunInput): Promise<CommandRunResult> {
  return new Promise((resolvePromise, reject) => {
    const startedAt = new Date().toISOString();
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let cleanupSignalListener: () => void = () => undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => input.onStdout?.(chunk));
    child.stderr.on('data', (chunk: string) => input.onStderr?.(chunk));
    child.once('error', (error) => {
      cleanupSignalListener();
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      cleanupSignalListener();
      const result: CommandRunResult = { exitCode, startedAt, finishedAt: new Date().toISOString() };
      if (signal !== null) result.signal = signal;
      resolvePromise(result);
    });

    if (input.signal) {
      const abort = () => {
        child.kill('SIGTERM');
      };
      if (input.signal.aborted) abort();
      else {
        input.signal.addEventListener('abort', abort, { once: true });
        cleanupSignalListener = () => input.signal?.removeEventListener('abort', abort);
      }
    }
  });
}

function createLinkedAbortController(signal: AbortSignal | undefined, onExternalAbort: () => void): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  if (!signal) return { controller, dispose: () => undefined };
  const abort = () => {
    onExternalAbort();
    controller.abort();
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener('abort', abort),
  };
}

function redactPromptArg(args: readonly string[]): readonly string[] {
  if (args.length === 0) return [];
  return [...args.slice(0, -1), '<prompt>'];
}
