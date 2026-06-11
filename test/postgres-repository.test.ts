import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import { PostgreSqlRepository, createTaskIdempotencySignature } from '../src/db/postgres-repository.js';
import { PostgreSqlStatements } from '../src/db/postgres-statements.js';
import type { SqlClient, SqlQueryResult } from '../src/db/transaction.js';

const NOW = '2026-06-11T00:00:00.000Z';

class ScriptedSqlClient implements SqlClient {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  private readonly script: Array<SqlQueryResult<Record<string, unknown>> | Error> = [];

  enqueue(result: SqlQueryResult<Record<string, unknown>> | Error): void {
    this.script.push(result);
  }

  async query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push(params ? { sql, params } : { sql });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 } as SqlQueryResult<Row>;
    const next = this.script.shift();
    if (!next) throw new Error(`missing scripted result for ${sql.slice(0, 40)}`);
    if (next instanceof Error) throw next;
    return next as SqlQueryResult<Row>;
  }
}

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    domain: 'personal',
    source: 'telegram',
    source_ref: 'telegram:chat:msg',
    payload: { text: 'hello' },
    task_spec: { route: { runner: 'codex' } },
    status: 'QUEUED',
    current_run_id: '00000000-0000-4000-8000-000000000101',
    retry_count: 0,
    max_retries: 1,
    idempotency_key: 'idem-1',
    idempotency_signature: 'signature',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    task_id: '00000000-0000-4000-8000-000000000001',
    domain: 'personal',
    status: 'QUEUED',
    attempt_no: 1,
    retry_of_run_id: null,
    instruction: { type: 'codex_session', requiredCapabilities: ['codex:exec'] },
    result: null,
    error: null,
    metrics: {},
    current_lease_id: null,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    started_at: null,
    finished_at: null,
    deadline_at: null,
    ...overrides,
  };
}

function leaseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    run_id: '00000000-0000-4000-8000-000000000101',
    domain: 'personal',
    device_id: '00000000-0000-4000-8000-000000000301',
    runner_id: '00000000-0000-4000-8000-000000000401',
    status: 'ACKED',
    issued_at: NOW,
    expires_at: '2026-06-11T00:05:00.000Z',
    acked_at: NOW,
    renewed_at: null,
    completed_at: null,
    cancelled_at: null,
    expire_reason: null,
    terminal_payload_hash: null,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: '00000000-0000-4000-8000-000000000101',
    seq: 1,
    domain: 'personal',
    event_type: 'STDOUT',
    payload: { text: 'hello' },
    emitted_at: NOW,
    ...overrides,
  };
}

function one(row: Record<string, unknown>): SqlQueryResult<Record<string, unknown>> {
  return { rows: [row], rowCount: 1 };
}

function none(): SqlQueryResult<Record<string, unknown>> {
  return { rows: [], rowCount: 0 };
}

test('PostgreSqlRepository creates a task/run and maps snake_case rows to domain records', async () => {
  const input = { source: 'telegram', sourceRef: 'telegram:chat:msg', payload: { text: 'hello' } };
  const signature = createTaskIdempotencySignature('personal', input);
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({ task: taskRow({ idempotency_signature: signature }), run: runRow() }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.createTaskWithInitialRun(input, 'idem-1');

  assert.equal(result.created, true);
  assert.equal(result.task.idempotencySignature, signature);
  assert.equal(result.run.attemptNo, 1);
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.findTaskByIdempotencyKey, PostgreSqlStatements.createTaskWithInitialRun, 'COMMIT']);
  assert.equal(client.calls[2]?.params?.[8], signature);
});

test('PostgreSqlRepository maps idempotency signature mismatch to AL_IDEMPOTENCY_CONFLICT', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ task: taskRow({ idempotency_signature: 'different' }), run: runRow() }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  await assert.rejects(
    repo.createTaskWithInitialRun({ source: 'telegram', sourceRef: 'telegram:chat:msg', payload: { text: 'hello' } }, 'idem-1'),
    (error) => error instanceof AgentlinkError && error.code === 'AL_IDEMPOTENCY_CONFLICT',
  );
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.findTaskByIdempotencyKey, 'ROLLBACK']);
});

test('PostgreSqlRepository classifies progress insert misses as replay, conflict, or expired lease', async () => {
  const replayClient = new ScriptedSqlClient();
  replayClient.enqueue(none());
  replayClient.enqueue(one(eventRow()));
  const replayRepo = new PostgreSqlRepository(replayClient, { now: () => new Date(NOW) });
  const replay = await replayRepo.appendAgentletProgress({ runId: 'run-1', leaseId: 'lease-1', seq: 1, eventType: 'STDOUT', payload: { text: 'hello' } });
  assert.equal(replay.eventType, 'STDOUT');

  const conflictClient = new ScriptedSqlClient();
  conflictClient.enqueue(none());
  conflictClient.enqueue(one(eventRow({ payload: { text: 'different' } })));
  const conflictRepo = new PostgreSqlRepository(conflictClient, { now: () => new Date(NOW) });
  await assert.rejects(
    conflictRepo.appendAgentletProgress({ runId: 'run-1', leaseId: 'lease-1', seq: 1, eventType: 'STDOUT', payload: { text: 'hello' } }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_IDEMPOTENCY_CONFLICT',
  );

  const expiredClient = new ScriptedSqlClient();
  expiredClient.enqueue(none());
  expiredClient.enqueue(none());
  const expiredRepo = new PostgreSqlRepository(expiredClient, { now: () => new Date(NOW) });
  await assert.rejects(
    expiredRepo.appendAgentletProgress({ runId: 'run-1', leaseId: 'lease-1', seq: 1, eventType: 'STDOUT', payload: { text: 'hello' } }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_LEASE_EXPIRED',
  );
});

test('PostgreSqlRepository completes retryable failures and creates the next attempt in one transaction', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({
    lease: leaseRow({ status: 'COMPLETED', terminal_payload_hash: 'hash', completed_at: NOW }),
    run: runRow({ status: 'FAILED', error: { retryable: true }, finished_at: NOW }),
    task: taskRow({ status: 'FAILED', retry_count: 0, max_retries: 1 }),
  }));
  client.enqueue(one({
    run: runRow({ id: '00000000-0000-4000-8000-000000000102', status: 'QUEUED', attempt_no: 2, retry_of_run_id: '00000000-0000-4000-8000-000000000101' }),
    task: taskRow({ status: 'QUEUED', retry_count: 1, current_run_id: '00000000-0000-4000-8000-000000000102' }),
  }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.completeRun({ runId: 'run-1', leaseId: 'lease-1', status: 'FAILED', error: { retryable: true } });

  assert.equal(result.run.status, 'FAILED');
  assert.equal(result.task.status, 'QUEUED');
  assert.equal(result.retryRun?.attemptNo, 2);
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.completeRun, PostgreSqlStatements.createRetryRunAttempt, 'COMMIT']);
});



test('PostgreSqlRepository maps different terminal replay payloads to AL_IDEMPOTENCY_CONFLICT', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(none());
  client.enqueue(one({
    lease: leaseRow({ status: 'COMPLETED', terminal_payload_hash: 'stored-hash', completed_at: NOW }),
    run: runRow({ status: 'SUCCEEDED', result: { text: 'stored' }, finished_at: NOW }),
    task: taskRow({ status: 'SUCCEEDED' }),
  }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  await assert.rejects(
    repo.completeRun({ runId: 'run-1', leaseId: 'lease-1', status: 'SUCCEEDED', result: { text: 'different' } }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_IDEMPOTENCY_CONFLICT',
  );
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.completeRun,
    PostgreSqlStatements.replayTerminalComplete,
    PostgreSqlStatements.findTerminalCompleteByRunLease,
    'ROLLBACK',
  ]);
});

test('PostgreSqlRepository expires leases and creates retry attempts in one transaction', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({
    lease: leaseRow({ status: 'EXPIRED', expire_reason: 'lease_expired' }),
    run: runRow({ status: 'TIMED_OUT', finished_at: NOW }),
    task: taskRow({ status: 'FAILED', retry_count: 0, max_retries: 1 }),
  }));
  client.enqueue(one({
    run: runRow({ id: '00000000-0000-4000-8000-000000000102', status: 'QUEUED', attempt_no: 2, retry_of_run_id: '00000000-0000-4000-8000-000000000101' }),
    task: taskRow({ status: 'QUEUED', retry_count: 1, current_run_id: '00000000-0000-4000-8000-000000000102' }),
  }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.expireActiveLease('00000000-0000-4000-8000-000000000201');

  assert.equal(result.run.status, 'TIMED_OUT');
  assert.equal(result.task.status, 'QUEUED');
  assert.equal(result.retryRun?.attemptNo, 2);
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.expireActiveLease, PostgreSqlStatements.createRetryRunAttempt, 'COMMIT']);
});

test('PostgreSqlRepository replays terminal complete before returning AL_LEASE_EXPIRED', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({
    lease: leaseRow({ status: 'COMPLETED', terminal_payload_hash: 'hash', completed_at: NOW }),
    run: runRow({ status: 'SUCCEEDED', result: { text: 'done' }, finished_at: NOW }),
    task: taskRow({ status: 'SUCCEEDED' }),
  }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.completeRun({ runId: 'run-1', leaseId: 'lease-1', status: 'SUCCEEDED', result: { text: 'done' } });

  assert.equal(result.run.status, 'SUCCEEDED');
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.completeRun, PostgreSqlStatements.replayTerminalComplete, 'COMMIT']);
});
