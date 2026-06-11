import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import { PostgreSqlRepository, createTaskIdempotencySignature } from '../src/db/postgres-repository.js';
import { PostgreSqlStatements } from '../src/db/postgres-statements.js';
import { hashStable } from '../src/domain/signature.js';
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

function deviceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000301',
    domain: 'personal',
    display_name: 'claw-tenc',
    token_hash: 'token-hash',
    network_scope: 'personal',
    owner_user_id: 'whiteParachute',
    trust_level: 'standard',
    status: 'ONLINE',
    revoked_at: null,
    last_auth_at: NOW,
    last_heartbeat_at: NOW,
    agentlet_version: 'test-agentlet',
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function runnerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000401',
    device_id: '00000000-0000-4000-8000-000000000301',
    runner_type: 'codex',
    runner_version: null,
    model: null,
    status: 'online',
    max_concurrency: 1,
    capabilities: ['codex:exec'],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function capabilityGrantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000501',
    domain: 'personal',
    device_id: '00000000-0000-4000-8000-000000000301',
    runner_id: '00000000-0000-4000-8000-000000000401',
    capability: 'codex:exec',
    grant_status: 'GRANTED',
    granted_by: 'device_register',
    granted_at: NOW,
    revoked_at: null,
    ...overrides,
  };
}

function workdirGrantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000601',
    domain: 'personal',
    device_id: '00000000-0000-4000-8000-000000000301',
    path_prefix: process.cwd(),
    access_mode: 'read_write',
    created_at: NOW,
    revoked_at: null,
    ...overrides,
  };
}

function policyDecisionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000701',
    domain: 'personal',
    task_id: '00000000-0000-4000-8000-000000000001',
    run_id: '00000000-0000-4000-8000-000000000101',
    device_id: '00000000-0000-4000-8000-000000000301',
    runner_id: '00000000-0000-4000-8000-000000000401',
    input: {},
    decision: 'ALLOW',
    reason: null,
    created_at: NOW,
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

test('PostgreSqlRepository registers devices with declared capabilities and grants', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one(deviceRow({ status: 'REGISTERED', token_hash: 'stored-hash' })));
  client.enqueue(one(runnerRow({ capabilities: undefined })));
  client.enqueue(one({}));
  client.enqueue(one({}));
  client.enqueue(one({}));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.registerDevice({
    displayName: 'claw-tenc',
    ownerUserId: 'whiteParachute',
    agentletVersion: 'test-agentlet',
    capabilityGrants: ['codex:exec'],
    workdirGrants: [{ pathPrefix: process.cwd(), accessMode: 'read_write' }],
  });

  assert.equal(result.device.status, 'REGISTERED');
  assert.equal(result.runner.capabilities.includes('codex:exec'), true);
  assert.match(result.deviceSecret, /^al_dev_/);
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.insertDevice,
    PostgreSqlStatements.insertRunner,
    PostgreSqlStatements.insertCapabilityDeclared,
    PostgreSqlStatements.insertCapabilityGrant,
    PostgreSqlStatements.insertWorkdirGrant,
    'COMMIT',
  ]);
});

test('PostgreSqlRepository authenticates and heartbeats devices via token hash', async () => {
  const secret = 'al_dev_test';
  const client = new ScriptedSqlClient();
  client.enqueue(one({ device: deviceRow({ token_hash: hashStable({ secret }), status: 'REGISTERED' }) }));
  client.enqueue(one(deviceRow({ token_hash: hashStable({ secret }), status: 'ONLINE' })));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const device = await repo.heartbeat('00000000-0000-4000-8000-000000000301', secret);

  assert.equal(device.status, 'ONLINE');
  assert.deepEqual(client.calls.map((call) => call.sql), [PostgreSqlStatements.findDeviceById, PostgreSqlStatements.heartbeatDevice]);

  const invalidClient = new ScriptedSqlClient();
  invalidClient.enqueue(one({ device: deviceRow({ token_hash: hashStable({ secret: 'other' }) }) }));
  const invalidRepo = new PostgreSqlRepository(invalidClient, { now: () => new Date(NOW) });
  await assert.rejects(
    invalidRepo.authenticateDevice('00000000-0000-4000-8000-000000000301', secret),
    (error) => error instanceof AgentlinkError && error.code === 'AL_AUTH_INVALID',
  );
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

test('PostgreSqlRepository evaluates static grants before leasing a queued run', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ device: deviceRow() }));
  client.enqueue(one({ runner: runnerRow() }));
  client.enqueue(one({ run: runRow({ instruction: { type: 'codex_session', requiredCapabilities: ['codex:exec'], workspace: process.cwd(), networkScope: 'personal' } }), task: taskRow() }));
  client.enqueue(one(capabilityGrantRow()));
  client.enqueue(one(workdirGrantRow()));
  client.enqueue(one(policyDecisionRow()));
  client.enqueue(one({
    lease: leaseRow({ status: 'ISSUED', acked_at: null }),
    run: runRow({ status: 'LEASED', current_lease_id: '00000000-0000-4000-8000-000000000201', policy_decision_id: '00000000-0000-4000-8000-000000000701' }),
    task: taskRow({ status: 'RUNNING' }),
  }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.pullNextPolicyApprovedRun({
    deviceId: '00000000-0000-4000-8000-000000000301',
    runnerId: '00000000-0000-4000-8000-000000000401',
  });

  assert.equal(result?.lease.status, 'ISSUED');
  assert.deepEqual(client.calls.map((call) => call.sql), [
    PostgreSqlStatements.findDeviceById,
    PostgreSqlStatements.findRunnerById,
    PostgreSqlStatements.findDispatchCandidates,
    PostgreSqlStatements.findActiveCapabilityGrantsForRunner,
    PostgreSqlStatements.findActiveWorkdirGrantsForDevice,
    PostgreSqlStatements.insertPolicyDecision,
    PostgreSqlStatements.leaseSpecificQueuedRun,
  ]);
  assert.equal(client.calls.at(-1)?.params?.[7], '00000000-0000-4000-8000-000000000701');
});

test('PostgreSqlRepository records policy denies and does not lease unauthorized runs', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ device: deviceRow() }));
  client.enqueue(one({ runner: runnerRow() }));
  client.enqueue(one({ run: runRow({ instruction: { type: 'codex_session', requiredCapabilities: ['codex:exec'], workspace: process.cwd(), networkScope: 'personal' } }), task: taskRow() }));
  client.enqueue(none());
  client.enqueue(one(workdirGrantRow()));
  client.enqueue(one(policyDecisionRow({ decision: 'DENY', reason: 'requested capability has no active grant' })));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  await assert.rejects(
    repo.pullNextPolicyApprovedRun({
      deviceId: '00000000-0000-4000-8000-000000000301',
      runnerId: '00000000-0000-4000-8000-000000000401',
    }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_CAPABILITY_DENIED',
  );
  assert.equal(client.calls.some((call) => call.sql === PostgreSqlStatements.leaseSpecificQueuedRun), false);
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

test('PostgreSqlRepository lists cancel control actions and recoverable active runs for a device', async () => {
  const controlClient = new ScriptedSqlClient();
  controlClient.enqueue(one({ lease: leaseRow({ status: 'CANCELLED', cancelled_at: NOW, expire_reason: 'user_cancelled' }), run: runRow({ status: 'CANCELLED' }) }));
  const controlRepo = new PostgreSqlRepository(controlClient, { now: () => new Date(NOW) });
  const actions = await controlRepo.listControlActionsForDevice('00000000-0000-4000-8000-000000000301');
  assert.deepEqual(actions, [{ type: 'cancel_run', runId: '00000000-0000-4000-8000-000000000101', leaseId: '00000000-0000-4000-8000-000000000201', reason: 'user_cancelled' }]);
  assert.deepEqual(controlClient.calls.map((call) => call.sql), [PostgreSqlStatements.listControlActionsForDevice]);

  const recoverClient = new ScriptedSqlClient();
  recoverClient.enqueue(one({ lease: leaseRow({ status: 'ACKED' }), run: runRow({ status: 'RUNNING' }), task: taskRow({ status: 'RUNNING' }) }));
  const recoverRepo = new PostgreSqlRepository(recoverClient, { now: () => new Date(NOW) });
  const recoverable = await recoverRepo.listRecoverableRunsForDevice('00000000-0000-4000-8000-000000000301');
  assert.equal(recoverable.length, 1);
  assert.equal(recoverable[0]?.runId, '00000000-0000-4000-8000-000000000101');
  assert.equal(recoverable[0]?.taskId, '00000000-0000-4000-8000-000000000001');
  assert.equal(recoverable[0]?.leaseStatus, 'ACKED');
  assert.equal(recoverable[0]?.runStatus, 'RUNNING');
  assert.deepEqual(recoverClient.calls.map((call) => call.sql), [PostgreSqlStatements.listRecoverableRunsForDevice]);
});
