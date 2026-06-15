import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import { PostgreSqlRepository, createTaskIdempotencySignature } from '../src/db/postgres-repository.js';
import { PostgreSqlStatements } from '../src/db/postgres-statements.js';
import { hashStable } from '../src/domain/signature.js';
import { TASK_RETENTION_DEFAULTS, MAIN_USER_RETENTION_DEFAULTS, RetentionMetadataError, normalizeRetentionMetadata } from '../src/domain/retention.js';
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
    retention_class: 'operational',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
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
    retention_class: 'operational',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
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

function controlActionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000801',
    domain: 'personal',
    device_id: '00000000-0000-4000-8000-000000000301',
    run_id: '00000000-0000-4000-8000-000000000101',
    lease_id: '00000000-0000-4000-8000-000000000201',
    action_type: 'cancel_run',
    status: 'PENDING',
    reason: 'user_cancelled',
    created_at: NOW,
    acknowledged_at: null,
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
    retention_class: 'short_term',
    memory_space: 'default',
    source_system: 'agentlet',
    sensitivity: 'internal',
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
  const retention = normalizeRetentionMetadata(undefined, TASK_RETENTION_DEFAULTS);
  const signature = createTaskIdempotencySignature('personal', input, retention);
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

test('PostgreSqlRepository replays existing task when idempotency key and signature match', async () => {
  const input = { source: 'telegram', sourceRef: 'telegram:chat:msg', payload: { text: 'hello' } };
  const retention = normalizeRetentionMetadata(undefined, TASK_RETENTION_DEFAULTS);
  const signature = createTaskIdempotencySignature('personal', input, retention);
  const client = new ScriptedSqlClient();
  client.enqueue(one({ task: taskRow({ idempotency_signature: signature, idempotency_key: 'idem-replay' }), run: runRow() }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.createTaskWithInitialRun(input, 'idem-replay');

  assert.equal(result.created, false);
  assert.equal(result.task.idempotencySignature, signature);
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.findTaskByIdempotencyKey, 'COMMIT']);
});

test('PostgreSqlRepository idempotency replay matches omitted vs explicit default retention', async () => {
  const inputOmitted = { source: 'telegram', sourceRef: 'telegram:chat:msg', payload: { text: 'hello' } };
  const inputExplicit = {
    source: 'telegram',
    sourceRef: 'telegram:chat:msg',
    payload: { text: 'hello' },
    retention: { retentionClass: 'operational', sensitivity: 'internal', memorySpace: 'default', sourceSystem: 'agentlink' },
  };
  const sigOmitted = createTaskIdempotencySignature('personal', inputOmitted, normalizeRetentionMetadata(undefined, TASK_RETENTION_DEFAULTS));
  const sigExplicit = createTaskIdempotencySignature('personal', inputExplicit, normalizeRetentionMetadata(inputExplicit.retention, TASK_RETENTION_DEFAULTS));
  assert.equal(sigOmitted, sigExplicit);
});

test('PostgreSqlRepository task/run/event records carry retention metadata (unique raw guard)', async () => {
  const rawPayload = { text: 'raw user message', user_id: 12345, channel: 'private' };
  const input = { source: 'telegram', sourceRef: 'telegram:chat:raw', payload: rawPayload };
  const retention = normalizeRetentionMetadata(undefined, TASK_RETENTION_DEFAULTS);
  const signature = createTaskIdempotencySignature('personal', input, retention);
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({ task: taskRow({ idempotency_signature: signature, payload: rawPayload }), run: runRow({ payload: undefined, instruction: rawPayload }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.createTaskWithInitialRun(input, 'raw-guard-key');

  assert.equal(result.created, true);
  assert.equal(result.task.retentionClass, 'operational');
  assert.equal(result.task.memorySpace, 'default');
  assert.equal(result.task.sourceSystem, 'agentlink');
  assert.equal(result.task.sensitivity, 'internal');
  assert.equal(result.run.retentionClass, 'operational');
  assert.equal(result.run.memorySpace, 'default');
  // Raw payload is preserved in the task record
  assert.deepEqual(result.task.payload, rawPayload);
  // Create params include retention columns
  const createParams = client.calls[2]?.params as readonly unknown[];
  assert.equal(createParams?.[9], 'operational');
  assert.equal(createParams?.[10], 'default');
  assert.equal(createParams?.[11], 'agentlink');
  assert.equal(createParams?.[12], 'internal');
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

test('PostgreSqlRepository manages capability and workdir grants', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ device: deviceRow() }));
  client.enqueue(one({ runner: runnerRow() }));
  client.enqueue(none());
  client.enqueue(one(capabilityGrantRow({ granted_by: 'operator' })));
  client.enqueue(one({ device: deviceRow() }));
  client.enqueue(none());
  client.enqueue(one(workdirGrantRow()));
  client.enqueue(one(capabilityGrantRow({ grant_status: 'REVOKED', revoked_at: NOW })));
  client.enqueue(one(workdirGrantRow({ revoked_at: NOW })));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const capability = await repo.grantCapability({
    deviceId: '00000000-0000-4000-8000-000000000301',
    runnerId: '00000000-0000-4000-8000-000000000401',
    capability: 'codex:exec',
    grantedBy: 'operator',
  });
  assert.equal(capability.grantedBy, 'operator');

  const workdir = await repo.grantWorkdir({
    deviceId: '00000000-0000-4000-8000-000000000301',
    pathPrefix: process.cwd(),
    accessMode: 'read_write',
  });
  assert.equal(workdir.pathPrefix, process.cwd());

  assert.equal((await repo.revokeCapabilityGrant(capability.id)).grantStatus, 'REVOKED');
  assert.equal((await repo.revokeWorkdirGrant(workdir.id)).revokedAt, NOW);

  assert.deepEqual(client.calls.map((call) => call.sql), [
    PostgreSqlStatements.findDeviceById,
    PostgreSqlStatements.findRunnerById,
    PostgreSqlStatements.findActiveCapabilityGrantsForRunner,
    PostgreSqlStatements.insertCapabilityGrant,
    PostgreSqlStatements.findDeviceById,
    PostgreSqlStatements.findActiveWorkdirGrantsForDevice,
    PostgreSqlStatements.insertWorkdirGrant,
    PostgreSqlStatements.revokeCapabilityGrant,
    PostgreSqlStatements.revokeWorkdirGrant,
  ]);
});

test('PostgreSqlRepository revokes a device and cascades current active work', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ device: deviceRow({ status: 'REVOKED', revoked_at: NOW }) }));
  client.enqueue(one({
    task: taskRow({ status: 'CANCELLED' }),
    run: runRow({ status: 'CANCELLED', current_lease_id: '00000000-0000-4000-8000-000000000201' }),
    lease: leaseRow({ status: 'CANCELLED', cancelled_at: NOW, expire_reason: 'operator_revoked' }),
  }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const revoked = await repo.revokeDevice('00000000-0000-4000-8000-000000000301', 'operator_revoked');

  assert.equal(revoked.device.status, 'REVOKED');
  assert.equal(revoked.leases[0]?.status, 'CANCELLED');
  assert.equal(revoked.leases[0]?.expireReason, 'operator_revoked');
  assert.equal(revoked.runs[0]?.status, 'CANCELLED');
  assert.equal(revoked.tasks[0]?.status, 'CANCELLED');
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.revokeDevice, PostgreSqlStatements.cancelActiveLeasesForDevice, 'COMMIT']);
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

test('PostgreSqlRepository appendAgentletProgress carries retention metadata with agentlet defaults', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one(eventRow()));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const event = await repo.appendAgentletProgress({
    runId: 'run-1',
    leaseId: 'lease-1',
    seq: 1,
    eventType: 'STDOUT',
    payload: { text: 'hello' },
  });

  assert.equal(event.retentionClass, 'short_term');
  assert.equal(event.sourceSystem, 'agentlet');
  assert.equal(event.memorySpace, 'default');
  assert.equal(event.sensitivity, 'internal');
  // Raw payload is preserved through the mapper
  assert.deepEqual(event.payload, { text: 'hello' });
  // Verify retention params are passed to the SQL INSERT statement
  const appendCall = client.calls.find((call) => call.sql === PostgreSqlStatements.appendAgentletProgress);
  assert.ok(appendCall);
  const params = appendCall.params as readonly unknown[];
  assert.equal(params?.[5], 'short_term');
  assert.equal(params?.[6], 'default');
  assert.equal(params?.[7], 'agentlet');
  assert.equal(params?.[8], 'internal');
});

test('PostgreSqlRepository appendAgentletProgress accepts explicit retention override', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one(eventRow({ retention_class: 'artifact', sensitivity: 'public' })));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const event = await repo.appendAgentletProgress({
    runId: 'run-1',
    leaseId: 'lease-1',
    seq: 1,
    eventType: 'artifact',
    payload: { hash: 'abc123' },
    retention: { retentionClass: 'artifact', sensitivity: 'public' },
  });

  assert.equal(event.retentionClass, 'artifact');
  assert.equal(event.sensitivity, 'public');
});

test('PostgreSqlRepository appendAgentletProgress rejects invalid retention', async () => {
  const client = new ScriptedSqlClient();
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  await assert.rejects(
    repo.appendAgentletProgress({
      runId: 'run-1',
      leaseId: 'lease-1',
      seq: 1,
      eventType: 'STDOUT',
      payload: { text: 'hi' },
      retention: { retentionClass: 'bogus' },
    }),
    (error) => error instanceof RetentionMetadataError && error.field === 'retention_class',
  );
  // No SQL calls should have been made
  assert.equal(client.calls.length, 0);
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

test('PostgreSqlRepository retry run inherits retention metadata from task', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({
    lease: leaseRow({ status: 'COMPLETED', terminal_payload_hash: 'hash', completed_at: NOW }),
    run: runRow({ status: 'FAILED', error: { retryable: true }, finished_at: NOW, retention_class: 'short_term', source_system: 'agentlet' }),
    task: taskRow({ status: 'FAILED', retry_count: 0, max_retries: 1, retention_class: 'operational', source_system: 'agentlink', sensitivity: 'confidential', memory_space: 'work.projectx' }),
  }));
  client.enqueue(one({
    run: runRow({
      id: '00000000-0000-4000-8000-000000000102',
      status: 'QUEUED',
      attempt_no: 2,
      retry_of_run_id: '00000000-0000-4000-8000-000000000101',
      retention_class: 'operational',
      memory_space: 'work.projectx',
      source_system: 'agentlink',
      sensitivity: 'confidential',
    }),
    task: taskRow({ status: 'QUEUED', retry_count: 1, current_run_id: '00000000-0000-4000-8000-000000000102' }),
  }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.completeRun({ runId: 'run-1', leaseId: 'lease-1', status: 'FAILED', error: { retryable: true } });

  assert.equal(result.retryRun?.retentionClass, 'operational');
  assert.equal(result.retryRun?.memorySpace, 'work.projectx');
  assert.equal(result.retryRun?.sourceSystem, 'agentlink');
  assert.equal(result.retryRun?.sensitivity, 'confidential');
  // Retry run inherits from TASK, not from the old failed run
  assert.notEqual(result.retryRun?.retentionClass, result.run.retentionClass);
  assert.notEqual(result.retryRun?.sourceSystem, result.run.sourceSystem);
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
  controlClient.enqueue(one({ control_action: controlActionRow() }));
  const controlRepo = new PostgreSqlRepository(controlClient, { now: () => new Date(NOW) });
  const actions = await controlRepo.listControlActionsForDevice('00000000-0000-4000-8000-000000000301');
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.id, '00000000-0000-4000-8000-000000000801');
  assert.equal(actions[0]?.type, 'cancel_run');
  assert.equal(actions[0]?.deviceId, '00000000-0000-4000-8000-000000000301');
  assert.equal(actions[0]?.runId, '00000000-0000-4000-8000-000000000101');
  assert.equal(actions[0]?.leaseId, '00000000-0000-4000-8000-000000000201');
  assert.equal(actions[0]?.status, 'PENDING');
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

test('PostgreSqlRepository renews leases, acknowledges control actions, and applies recovery decisions', async () => {
  const renewClient = new ScriptedSqlClient();
  renewClient.enqueue(one({
    lease: leaseRow({ status: 'RENEWED', renewed_at: NOW }),
    run: runRow({ status: 'RUNNING' }),
    task: taskRow({ status: 'RUNNING' }),
  }));
  const renewRepo = new PostgreSqlRepository(renewClient, { now: () => new Date(NOW) });
  const renewed = await renewRepo.renewLease('00000000-0000-4000-8000-000000000201');
  assert.equal(renewed.lease.status, 'RENEWED');
  assert.deepEqual(renewClient.calls.map((call) => call.sql), [PostgreSqlStatements.renewLease]);

  const ackClient = new ScriptedSqlClient();
  ackClient.enqueue(one({ control_action: controlActionRow({ status: 'ACKED', acknowledged_at: NOW }) }));
  const ackRepo = new PostgreSqlRepository(ackClient, { now: () => new Date(NOW) });
  const acked = await ackRepo.ackControlAction('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000801');
  assert.equal(acked.status, 'ACKED');
  assert.equal(acked.acknowledgedAt, NOW);
  assert.deepEqual(ackClient.calls.map((call) => call.sql), [PostgreSqlStatements.ackControlAction]);

  const continueClient = new ScriptedSqlClient();
  continueClient.enqueue(one({
    lease: leaseRow({ status: 'RENEWED', renewed_at: NOW }),
    run: runRow({ status: 'RUNNING' }),
    task: taskRow({ status: 'RUNNING' }),
  }));
  const continueRepo = new PostgreSqlRepository(continueClient, { now: () => new Date(NOW) });
  const continued = await continueRepo.recoverContinue('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000301');
  assert.equal(continued.lease.status, 'RENEWED');
  assert.equal(continued.run.status, 'RUNNING');
  assert.deepEqual(continueClient.calls.map((call) => call.sql), [PostgreSqlStatements.recoverContinue]);

  const unackedContinueClient = new ScriptedSqlClient();
  unackedContinueClient.enqueue(none());
  unackedContinueClient.enqueue(one({
    lease: leaseRow({ status: 'ISSUED', acked_at: null }),
    run: runRow({ status: 'LEASED', current_lease_id: '00000000-0000-4000-8000-000000000201' }),
  }));
  const unackedContinueRepo = new PostgreSqlRepository(unackedContinueClient, { now: () => new Date(NOW) });
  await assert.rejects(
    unackedContinueRepo.recoverContinue('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000301'),
    (error) => error instanceof AgentlinkError && error.code === 'AL_STATE_CONFLICT',
  );
  assert.deepEqual(unackedContinueClient.calls.map((call) => call.sql), [
    PostgreSqlStatements.recoverContinue,
    PostgreSqlStatements.findRecoverableLeaseForDecision,
  ]);

  const staleContinueClient = new ScriptedSqlClient();
  staleContinueClient.enqueue(none());
  staleContinueClient.enqueue(none());
  const staleContinueRepo = new PostgreSqlRepository(staleContinueClient, { now: () => new Date(NOW) });
  await assert.rejects(
    staleContinueRepo.recoverContinue('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000301'),
    (error) => error instanceof AgentlinkError && error.code === 'AL_LEASE_EXPIRED',
  );
  assert.deepEqual(staleContinueClient.calls.map((call) => call.sql), [
    PostgreSqlStatements.recoverContinue,
    PostgreSqlStatements.findRecoverableLeaseForDecision,
  ]);

  const discardClient = new ScriptedSqlClient();
  discardClient.enqueue(one({
    lease: leaseRow({ status: 'EXPIRED', expire_reason: 'lost_process' }),
    run: runRow({ status: 'TIMED_OUT', finished_at: NOW }),
    task: taskRow({ status: 'FAILED', retry_count: 0, max_retries: 1 }),
  }));
  discardClient.enqueue(one({
    run: runRow({ id: '00000000-0000-4000-8000-000000000102', status: 'QUEUED', attempt_no: 2, retry_of_run_id: '00000000-0000-4000-8000-000000000101' }),
    task: taskRow({ status: 'QUEUED', retry_count: 1, current_run_id: '00000000-0000-4000-8000-000000000102' }),
  }));
  const discardRepo = new PostgreSqlRepository(discardClient, { now: () => new Date(NOW) });
  const discarded = await discardRepo.recoverDiscard('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000301', 'lost_process');
  assert.equal(discarded.lease.status, 'EXPIRED');
  assert.equal(discarded.run.status, 'TIMED_OUT');
  assert.equal(discarded.task.status, 'QUEUED');
  assert.equal(discarded.retryRun?.attemptNo, 2);
  assert.deepEqual(discardClient.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.recoverDiscard, PostgreSqlStatements.createRetryRunAttempt, 'COMMIT']);
});

function mainUserRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    singleton_key: 'main',
    display_name: 'Main User',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    metadata: { theme: 'dark' },
    retention_class: 'operational',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function channelUserRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000901',
    display_name: 'Channel User',
    category: 'unclassified',
    metadata: {},
    retention_class: 'operational',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function platformIdentityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000902',
    channel_user_id: '00000000-0000-4000-8000-000000000901',
    platform: 'feishu',
    external_id: 'Open-ID',
    normalized_external_id: 'Open-ID',
    display_name: 'Platform User',
    metadata: {},
    retention_class: 'operational',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function groupProfileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000903',
    platform: 'feishu',
    external_group_id: 'OC-1',
    normalized_external_group_id: 'OC-1',
    display_name: 'Group',
    group_type: 'general',
    tone: 'neutral',
    default_reply_mode: 'thread',
    context_scope: 'group',
    memory_scope: 'group',
    metadata: {},
    retention_class: 'operational',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

test('postgres repository maps main user row correctly', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ main_user: mainUserRow() }));
  const repo = new PostgreSqlRepository(client);
  const result = await repo.getMainUserProfile();
  assert.ok(result);
  assert.equal(result.id, 'main');
  assert.equal(result.displayName, 'Main User');
  assert.equal(result.locale, 'zh-CN');
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.deepEqual(result.metadata, { theme: 'dark' });
  assert.equal(result.retentionClass, 'operational');
  assert.equal(result.memorySpace, 'default');
  assert.equal(result.sourceSystem, 'agentlink');
  assert.equal(result.sensitivity, 'internal');
  assert.equal(result.createdAt, NOW);
  assert.equal(result.updatedAt, NOW);
});

test('postgres repository getMainUserProfile returns undefined when not found', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  const repo = new PostgreSqlRepository(client);
  const result = await repo.getMainUserProfile();
  assert.equal(result, undefined);
});

test('postgres repository upsertMainUserProfile creates on first call', async () => {
  const client = new ScriptedSqlClient();
  // getMainUserProfile returns empty
  client.enqueue(none());
  // upsert returns new row
  client.enqueue(one({ main_user: mainUserRow({ display_name: 'Alice' }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });
  const result = await repo.upsertMainUserProfile({ displayName: 'Alice' });
  assert.equal(result.created, true);
  assert.equal(result.mainUser.displayName, 'Alice');
  assert.equal(result.mainUser.id, 'main');
  // Verify call order: find then upsert
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls.at(0)?.sql, PostgreSqlStatements.findMainUserProfile);
  assert.equal(client.calls.at(1)?.sql, PostgreSqlStatements.upsertMainUserProfile);
});

test('postgres repository upsertMainUserProfile returns created=false on update', async () => {
  const client = new ScriptedSqlClient();
  // existing row
  client.enqueue(one({ main_user: mainUserRow({ display_name: 'Old' }) }));
  // updated row
  client.enqueue(one({ main_user: mainUserRow({ display_name: 'New' }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });
  const result = await repo.upsertMainUserProfile({ displayName: 'New' });
  assert.equal(result.created, false);
  assert.equal(result.mainUser.displayName, 'New');
});

test('postgres repository upsertMainUserProfile merges unspecified fields with existing', async () => {
  const client = new ScriptedSqlClient();
  // Find returns existing with locale=en-US and theme=dark
  client.enqueue(one({ main_user: mainUserRow({ locale: 'en-US', metadata: { theme: 'dark' } }) }));
  // Upsert returns merged
  client.enqueue(one({ main_user: mainUserRow({ display_name: 'Updated', locale: 'en-US', metadata: { theme: 'dark' } }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });
  const result = await repo.upsertMainUserProfile({ displayName: 'Updated' });
  assert.equal(result.created, false);
  // Verify the upsert params include existing locale and metadata (merged)
  const upsertCall = client.calls[1];
  assert.ok(upsertCall);
  const params = upsertCall.params as unknown[];
  // $1 = displayName (Updated), $2 = locale (en-US from existing), $3 = timezone
  assert.equal(params[0], 'Updated');
  assert.equal(params[1], 'en-US');
});

test('postgres repository upsertMainUserProfile normalizes retention', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({ main_user: mainUserRow() }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });
  await repo.upsertMainUserProfile({
    displayName: 'Test',
    retention: { memorySpace: 'personal', sensitivity: 'confidential' },
  });
  const upsertParams = client.calls[1]?.params as unknown[] | undefined;
  assert.ok(upsertParams);
  // $1=display_name, $2=locale, $3=timezone, $4=metadata, $5=retention_class, $6=memory_space, $7=source_system, $8=sensitivity
  assert.equal(upsertParams[4], 'operational');
  assert.equal(upsertParams[5], 'personal');
  assert.equal(upsertParams[6], 'agentlink');
  assert.equal(upsertParams[7], 'confidential');
});

test('postgres repository upsertMainUserProfile rejects invalid retention', async () => {
  const client = new ScriptedSqlClient();
  const repo = new PostgreSqlRepository(client);
  await assert.rejects(
    async () => repo.upsertMainUserProfile({ displayName: 'Test', retention: { retentionClass: 'invalid' as never } }),
    (error: unknown) => error instanceof RetentionMetadataError,
  );
  assert.equal(client.calls.length, 0);
});

test('postgres repository upsertChannelUser creates channel user and platform identity in one transaction', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({ channel_user: channelUserRow({ display_name: 'Alice', metadata: { source: 'chat' } }) }));
  client.enqueue(one({ platform_identity: platformIdentityRow({ display_name: 'Alice', metadata: { chat: 'oc_1' } }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.upsertChannelUser({
    platform: ' Feishu ',
    externalId: ' Open-ID ',
    displayName: 'Alice',
    channelUserMetadata: { source: 'chat' },
    platformIdentityMetadata: { chat: 'oc_1' },
  });

  assert.equal(result.created, true);
  assert.equal(result.channelUser.id, '00000000-0000-4000-8000-000000000901');
  assert.equal(result.platformIdentity.platform, 'feishu');
  assert.equal(result.platformIdentity.normalizedExternalId, 'Open-ID');
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findPlatformIdentityByNormalized,
    PostgreSqlStatements.insertChannelUser,
    PostgreSqlStatements.insertPlatformIdentity,
    'COMMIT',
  ]);
  assert.equal(client.calls[1]?.params?.[0], 'feishu');
  assert.equal(client.calls[1]?.params?.[1], 'Open-ID');
});

test('postgres repository upsertChannelUser reuses existing identity and updates metadata', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ channel_user: channelUserRow(), platform_identity: platformIdentityRow() }));
  client.enqueue(one({ channel_user: channelUserRow({ display_name: 'Alice Updated', metadata: { source: 'updated' } }) }));
  client.enqueue(one({ platform_identity: platformIdentityRow({ display_name: 'Alice Updated', metadata: { chat: 'oc_2' } }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.upsertChannelUser({
    platform: 'feishu',
    externalId: 'Open-ID',
    displayName: 'Alice Updated',
    channelUserMetadata: { source: 'updated' },
    platformIdentityMetadata: { chat: 'oc_2' },
  });

  assert.equal(result.created, false);
  assert.equal(result.channelUser.displayName, 'Alice Updated');
  assert.deepEqual(result.platformIdentity.metadata, { chat: 'oc_2' });
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findPlatformIdentityByNormalized,
    PostgreSqlStatements.updateChannelUser,
    PostgreSqlStatements.updatePlatformIdentity,
    'COMMIT',
  ]);
});

test('postgres repository recovers identity unique race without orphan channel user', async () => {
  const unique = Object.assign(new Error('duplicate key'), { code: '23505' });
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({ channel_user: channelUserRow() }));
  client.enqueue(unique);
  client.enqueue(one({ channel_user: channelUserRow(), platform_identity: platformIdentityRow() }));
  client.enqueue(one({ channel_user: channelUserRow({ display_name: 'Race Winner' }) }));
  client.enqueue(one({ platform_identity: platformIdentityRow({ display_name: 'Race Winner' }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.upsertChannelUser({ platform: 'feishu', externalId: 'Open-ID', displayName: 'Race Winner' });

  assert.equal(result.created, false);
  assert.equal(result.channelUser.displayName, 'Race Winner');
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findPlatformIdentityByNormalized,
    PostgreSqlStatements.insertChannelUser,
    PostgreSqlStatements.insertPlatformIdentity,
    'ROLLBACK',
    'BEGIN',
    PostgreSqlStatements.findPlatformIdentityByNormalized,
    PostgreSqlStatements.updateChannelUser,
    PostgreSqlStatements.updatePlatformIdentity,
    'COMMIT',
  ]);
});

test('postgres repository set category and resolve platform identity', async () => {
  const categoryClient = new ScriptedSqlClient();
  categoryClient.enqueue(one({ channel_user: channelUserRow({ category: 'family.child' }) }));
  const categoryRepo = new PostgreSqlRepository(categoryClient, { now: () => new Date(NOW) });
  const categorized = await categoryRepo.setChannelUserCategory({
    channelUserId: '00000000-0000-4000-8000-000000000901',
    category: ' family.child ',
  });
  assert.equal(categorized.channelUser.category, 'family.child');
  assert.equal(categoryClient.calls[0]?.sql, PostgreSqlStatements.updateChannelUserCategory);
  assert.equal(categoryClient.calls[0]?.params?.[1], 'family.child');

  const resolveClient = new ScriptedSqlClient();
  resolveClient.enqueue(one({ channel_user: channelUserRow(), platform_identity: platformIdentityRow() }));
  const resolveRepo = new PostgreSqlRepository(resolveClient);
  const resolved = await resolveRepo.resolvePlatformIdentity({ platform: 'Feishu', externalId: ' Open-ID ' });
  assert.ok(resolved);
  assert.equal(resolved.platformIdentity.platform, 'feishu');
  assert.equal(resolveClient.calls[0]?.sql, PostgreSqlStatements.findPlatformIdentityByNormalized);

  const notFoundClient = new ScriptedSqlClient();
  notFoundClient.enqueue(none());
  const notFoundRepo = new PostgreSqlRepository(notFoundClient);
  assert.equal(await notFoundRepo.resolvePlatformIdentity({ platform: 'feishu', externalId: 'missing' }), undefined);
});

test('postgres repository upsertGroupProfile creates group profile in one transaction', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({ group_profile: groupProfileRow({ display_name: '研发群', metadata: { source: 'chat' } }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.upsertGroupProfile({
    platform: ' Feishu ',
    externalGroupId: ' OC-1 ',
    displayName: '研发群',
    metadata: { source: 'chat' },
  });

  assert.equal(result.created, true);
  assert.equal(result.groupProfile.platform, 'feishu');
  assert.equal(result.groupProfile.normalizedExternalGroupId, 'OC-1');
  assert.equal(result.groupProfile.displayName, '研发群');
  assert.equal(result.groupProfile.defaultReplyMode, 'thread');
  assert.equal(result.groupProfile.contextScope, 'group');
  assert.equal(result.groupProfile.memoryScope, 'group');
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findGroupProfileByNaturalKey,
    PostgreSqlStatements.insertGroupProfile,
    'COMMIT',
  ]);
  assert.equal(client.calls[1]?.params?.[0], 'feishu');
  assert.equal(client.calls[1]?.params?.[1], 'OC-1');
  assert.equal(client.calls[2]?.params?.[7], 'thread');
  assert.equal(client.calls[2]?.params?.[8], 'group');
  assert.equal(client.calls[2]?.params?.[9], 'group');
});

test('postgres repository upsertGroupProfile reuses existing natural key and updates defaults', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ group_profile: groupProfileRow() }));
  client.enqueue(one({ group_profile: groupProfileRow({
    display_name: '研发群 updated',
    group_type: 'team',
    tone: 'formal',
    default_reply_mode: 'dialog',
    context_scope: 'group.ops',
    memory_scope: 'group.ops',
    metadata: { source: 'updated' },
  }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.upsertGroupProfile({
    platform: 'feishu',
    externalGroupId: 'OC-1',
    displayName: '研发群 updated',
    groupType: 'team',
    tone: 'formal',
    defaultReplyMode: 'dialog',
    contextScope: 'group.ops',
    memoryScope: 'group.ops',
    metadata: { source: 'updated' },
  });

  assert.equal(result.created, false);
  assert.equal(result.groupProfile.id, '00000000-0000-4000-8000-000000000903');
  assert.equal(result.groupProfile.defaultReplyMode, 'dialog');
  assert.equal(result.groupProfile.contextScope, 'group.ops');
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findGroupProfileByNaturalKey,
    PostgreSqlStatements.updateGroupProfile,
    'COMMIT',
  ]);
  assert.equal(client.calls[2]?.params?.[6], 'dialog');
});

test('postgres repository recovers group profile unique race by re-reading existing profile', async () => {
  const unique = Object.assign(new Error('duplicate key'), { code: '23505' });
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(unique);
  client.enqueue(one({ group_profile: groupProfileRow() }));
  client.enqueue(one({ group_profile: groupProfileRow({ display_name: 'Race Winner' }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.upsertGroupProfile({ platform: 'feishu', externalGroupId: 'OC-1', displayName: 'Race Winner' });

  assert.equal(result.created, false);
  assert.equal(result.groupProfile.displayName, 'Race Winner');
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findGroupProfileByNaturalKey,
    PostgreSqlStatements.insertGroupProfile,
    'ROLLBACK',
    'BEGIN',
    PostgreSqlStatements.findGroupProfileByNaturalKey,
    PostgreSqlStatements.updateGroupProfile,
    'COMMIT',
  ]);
});

test('postgres repository get, resolve, set defaults, and not-found behavior for group profile', async () => {
  const getClient = new ScriptedSqlClient();
  getClient.enqueue(one({ group_profile: groupProfileRow({ display_name: '研发群' }) }));
  const getRepo = new PostgreSqlRepository(getClient);
  const got = await getRepo.getGroupProfile('00000000-0000-4000-8000-000000000903');
  assert.ok(got);
  assert.equal(got.displayName, '研发群');
  assert.equal(getClient.calls[0]?.sql, PostgreSqlStatements.findGroupProfileById);

  const resolveClient = new ScriptedSqlClient();
  resolveClient.enqueue(one({ group_profile: groupProfileRow() }));
  const resolveRepo = new PostgreSqlRepository(resolveClient);
  const resolved = await resolveRepo.resolveGroupProfile({ platform: ' Feishu ', externalGroupId: ' OC-1 ' });
  assert.ok(resolved);
  assert.equal(resolved.platform, 'feishu');
  assert.equal(resolveClient.calls[0]?.sql, PostgreSqlStatements.findGroupProfileByNaturalKey);

  const defaultsClient = new ScriptedSqlClient();
  defaultsClient.enqueue(one({ group_profile: groupProfileRow({ default_reply_mode: 'dialog', context_scope: 'group.support', memory_scope: 'group.support', tone: 'friendly' }) }));
  const defaultsRepo = new PostgreSqlRepository(defaultsClient, { now: () => new Date(NOW) });
  const updated = await defaultsRepo.setGroupProfileDefaults({
    groupProfileId: '00000000-0000-4000-8000-000000000903',
    defaultReplyMode: 'dialog',
    contextScope: ' group.support ',
    memoryScope: 'group.support',
    tone: 'friendly',
  });
  assert.equal(updated.groupProfile.defaultReplyMode, 'dialog');
  assert.equal(updated.groupProfile.contextScope, 'group.support');
  assert.equal(defaultsClient.calls[0]?.sql, PostgreSqlStatements.updateGroupProfileDefaults);
  assert.equal(defaultsClient.calls[0]?.params?.[1], 'dialog');
  assert.equal(defaultsClient.calls[0]?.params?.[2], 'group.support');

  const notFoundClient = new ScriptedSqlClient();
  notFoundClient.enqueue(none());
  const notFoundRepo = new PostgreSqlRepository(notFoundClient);
  await assert.rejects(
    async () => notFoundRepo.setGroupProfileDefaults({ groupProfileId: 'missing', defaultReplyMode: 'thread' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_GROUP_PROFILE_NOT_FOUND',
  );
});

function sourceEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000001001',
    source_system: 'feishu',
    source_ref: 'msg-1',
    source_hash: 'hmac-sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    event_type: 'message.receive',
    platform: 'feishu',
    occurred_at: NOW,
    received_at: NOW,
    payload: { raw: true },
    metadata: { trace: 't1' },
    retention_class: 'short_term',
    memory_space: 'default',
    sensitivity: 'internal',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function entryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000001101',
    source_event_id: '00000000-0000-4000-8000-000000001001',
    entry_type: 'group',
    platform: 'feishu',
    external_chat_id: 'oc_1',
    external_thread_id: 'thread_1',
    external_message_id: 'msg_1',
    speaker_channel_user_id: null,
    group_profile_id: null,
    agent_mentioned: true,
    body_text: 'hello',
    metadata: { parsed: true },
    retention_class: 'short_term',
    memory_space: 'default',
    source_system: 'feishu',
    sensitivity: 'internal',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

test('PostgreSqlRepository ingests source event and entry in one transaction', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({ source_event: sourceEventRow() }));
  client.enqueue(one({ entry: entryRow() }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW), sourceHashSecret: 'test-secret' });

  const result = await repo.ingestSourceEvent({
    sourceSystem: ' Feishu ',
    sourceRef: ' msg-1 ',
    eventType: 'message.receive',
    platform: 'Feishu',
    payload: { raw: true },
    metadata: { trace: 't1' },
    entryType: 'group',
    externalChatId: 'oc_1',
    externalThreadId: 'thread_1',
    externalMessageId: 'msg_1',
    agentMentioned: true,
    bodyText: 'hello',
    entryMetadata: { parsed: true },
  });

  assert.equal(result.created, true);
  assert.equal(result.sourceEvent.sourceSystem, 'feishu');
  assert.equal(result.entry.sourceEventId, result.sourceEvent.id);
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findSourceEventByNaturalKey,
    PostgreSqlStatements.insertSourceEvent,
    PostgreSqlStatements.insertEntry,
    'COMMIT',
  ]);
  const insertSourceParams = client.calls[2]?.params ?? [];
  assert.equal(insertSourceParams[1], 'feishu');
  assert.equal(insertSourceParams[2], 'msg-1');
  assert.match(String(insertSourceParams[3]), /^hmac-sha256:v1:[0-9a-f]{64}$/);
  assert.equal(insertSourceParams[10], 'short_term');
  const insertEntryParams = client.calls[3]?.params ?? [];
  assert.equal(insertEntryParams[2], 'group');
  assert.equal(insertEntryParams[14], 'feishu');
});

test('PostgreSqlRepository returns existing source event and entry on duplicate natural key', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(one({ source_event: sourceEventRow() }));
  client.enqueue(one({ entry: entryRow() }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW), sourceHashSecret: 'test-secret' });

  const result = await repo.ingestSourceEvent({ sourceSystem: 'feishu', sourceRef: 'msg-1', eventType: 'message.receive', bodyText: 'ignored' });

  assert.equal(result.created, false);
  assert.equal(result.sourceEvent.id, '00000000-0000-4000-8000-000000001001');
  assert.equal(result.entry.id, '00000000-0000-4000-8000-000000001101');
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.findSourceEventByNaturalKey, PostgreSqlStatements.findEntryBySourceEventId, 'COMMIT']);
});

test('PostgreSqlRepository recovers from source event unique race by re-reading durable rows', async () => {
  const client = new ScriptedSqlClient();
  const uniqueViolation = Object.assign(new Error('duplicate'), { code: '23505' });
  client.enqueue(none());
  client.enqueue(uniqueViolation);
  client.enqueue(one({ source_event: sourceEventRow() }));
  client.enqueue(one({ entry: entryRow() }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW), sourceHashSecret: 'test-secret' });

  const result = await repo.ingestSourceEvent({ sourceSystem: 'feishu', sourceRef: 'msg-1', eventType: 'message.receive' });

  assert.equal(result.created, false);
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findSourceEventByNaturalKey,
    PostgreSqlStatements.insertSourceEvent,
    'ROLLBACK',
    PostgreSqlStatements.findSourceEventByNaturalKey,
    PostgreSqlStatements.findEntryBySourceEventId,
  ]);
});

test('PostgreSqlRepository rejects missing optional speaker reference without auto-creating ChannelUser', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(none());
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW), sourceHashSecret: 'test-secret' });

  await assert.rejects(
    () => repo.ingestSourceEvent({ sourceSystem: 'feishu', sourceRef: 'missing-user', eventType: 'message.receive', speakerChannelUserId: 'missing' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_CHANNEL_USER_NOT_FOUND',
  );
  assert.deepEqual(client.calls.map((call) => call.sql), ['BEGIN', PostgreSqlStatements.findSourceEventByNaturalKey, PostgreSqlStatements.findChannelUserById, 'ROLLBACK']);
});

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000001201',
    session_scope: 'large',
    platform: 'feishu',
    external_chat_id: 'oc_1',
    external_thread_id: null,
    parent_session_id: null,
    group_profile_id: null,
    natural_key: 'group:feishu:oc_1',
    display_name: 'Group Session',
    metadata: { entry_type: 'group' },
    retention_class: 'operational',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

test('PostgreSqlRepository resolves thread entry into large and small sessions with entry backfill', async () => {
  const client = new ScriptedSqlClient();
  const large = sessionRow();
  const small = sessionRow({
    id: '00000000-0000-4000-8000-000000001202',
    session_scope: 'small',
    external_thread_id: 'thread_1',
    parent_session_id: large.id,
    natural_key: 'thread:feishu:oc_1:thread_1',
    display_name: 'Thread Session',
  });
  client.enqueue(one({ entry: entryRow({ entry_type: 'thread', group_profile_id: null, session_id: null }) }));
  client.enqueue(none());
  client.enqueue(one({ session: large }));
  client.enqueue(none());
  client.enqueue(one({ session: small }));
  client.enqueue(one({ entry: entryRow({ entry_type: 'thread', session_id: small.id }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.resolveSession({ entryId: '00000000-0000-4000-8000-000000001101' });

  assert.equal(result.created, true);
  assert.equal(result.largeSession.id, large.id);
  assert.equal(result.smallSession?.parentSessionId, large.id);
  assert.equal(result.session.id, small.id);
  assert.equal(result.entry.sessionId, small.id);
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findEntryById,
    PostgreSqlStatements.findSessionByNaturalKey,
    PostgreSqlStatements.insertSession,
    PostgreSqlStatements.findSessionByNaturalKey,
    PostgreSqlStatements.insertSession,
    PostgreSqlStatements.updateEntrySession,
    'COMMIT',
  ]);
  assert.equal(client.calls[3]?.params?.[1], 'large');
  assert.equal(client.calls[5]?.params?.[1], 'small');
  assert.equal(client.calls[5]?.params?.[5], large.id);
});

test('PostgreSqlRepository reuses existing sessions and can fetch entry session', async () => {
  const client = new ScriptedSqlClient();
  const large = sessionRow();
  client.enqueue(one({ entry: entryRow({ entry_type: 'group', external_thread_id: null, session_id: large.id }) }));
  client.enqueue(one({ session: large }));
  client.enqueue(one({ entry: entryRow({ entry_type: 'group', external_thread_id: null, session_id: large.id }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.resolveSession({ entryId: '00000000-0000-4000-8000-000000001101' });
  assert.equal(result.created, false);
  assert.equal(result.smallSession, undefined);
  assert.equal(result.entry.sessionId, large.id);

  const lookupClient = new ScriptedSqlClient();
  lookupClient.enqueue(one({ entry: entryRow({ session_id: large.id }) }));
  lookupClient.enqueue(one({ session: large }));
  const lookupRepo = new PostgreSqlRepository(lookupClient, { now: () => new Date(NOW) });
  const lookup = await lookupRepo.getEntrySession('00000000-0000-4000-8000-000000001101');
  assert.equal(lookup?.session.id, large.id);
  assert.deepEqual(lookupClient.calls.map((call) => call.sql), [PostgreSqlStatements.findEntryById, PostgreSqlStatements.findSessionById]);
});

test('PostgreSqlRepository recovers session unique race by re-reading durable session', async () => {
  const client = new ScriptedSqlClient();
  const unique = Object.assign(new Error('duplicate'), { code: '23505' });
  const large = sessionRow();
  client.enqueue(one({ entry: entryRow({ entry_type: 'group', external_thread_id: null, session_id: null }) }));
  client.enqueue(none());
  client.enqueue(unique);
  client.enqueue(one({ entry: entryRow({ entry_type: 'group', external_thread_id: null, session_id: null }) }));
  client.enqueue(one({ session: large }));
  client.enqueue(one({ entry: entryRow({ entry_type: 'group', external_thread_id: null, session_id: large.id }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.resolveSession({ entryId: '00000000-0000-4000-8000-000000001101' });
  assert.equal(result.created, false);
  assert.equal(result.session.id, large.id);
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findEntryById,
    PostgreSqlStatements.findSessionByNaturalKey,
    PostgreSqlStatements.insertSession,
    'ROLLBACK',
    'BEGIN',
    PostgreSqlStatements.findEntryById,
    PostgreSqlStatements.findSessionByNaturalKey,
    PostgreSqlStatements.updateEntrySession,
    'COMMIT',
  ]);
});

function memoryCandidateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000001301',
    session_id: '00000000-0000-4000-8000-000000001201',
    entry_id: '00000000-0000-4000-8000-000000001101',
    source_event_id: '00000000-0000-4000-8000-000000001001',
    candidate_text: '用户喜欢简洁回复',
    status: 'pending',
    reason: '',
    confidence: '0.750',
    natural_key: 'candidate:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    metadata: { extractor: 'manual' },
    retention_class: 'memory_candidate',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

test('PostgreSqlRepository creates memory candidate with referenced session and row_to_json envelope', async () => {
  const client = new ScriptedSqlClient();
  client.enqueue(none());
  client.enqueue(one({ session: sessionRow() }));
  client.enqueue(one({ entry: entryRow() }));
  client.enqueue(one({ source_event: sourceEventRow() }));
  client.enqueue(one({ memory_candidate: memoryCandidateRow() }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.createMemoryCandidate({
    sessionId: '00000000-0000-4000-8000-000000001201',
    entryId: '00000000-0000-4000-8000-000000001101',
    sourceEventId: '00000000-0000-4000-8000-000000001001',
    candidateText: ' 用户喜欢简洁回复 ',
    confidence: 0.75,
    metadata: { extractor: 'manual' },
  });

  assert.equal(result.created, true);
  assert.equal(result.memoryCandidate.retentionClass, 'memory_candidate');
  assert.equal(result.memoryCandidate.confidence, 0.75);
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findMemoryCandidateByNaturalKey,
    PostgreSqlStatements.findSessionById,
    PostgreSqlStatements.findEntryById,
    PostgreSqlStatements.findSourceEventById,
    PostgreSqlStatements.insertMemoryCandidate,
    'COMMIT',
  ]);
  assert.equal(client.calls[5]?.params?.[1], '00000000-0000-4000-8000-000000001201');
  assert.equal(client.calls[5]?.params?.[4], '用户喜欢简洁回复');
  assert.equal(client.calls[5]?.params?.[9], 'memory_candidate');
});

test('PostgreSqlRepository replays and lists memory candidates by session', async () => {
  const existing = memoryCandidateRow({ status: 'accepted', reason: 'reviewed', confidence: null });
  const replayClient = new ScriptedSqlClient();
  replayClient.enqueue(one({ memory_candidate: existing }));
  const replayRepo = new PostgreSqlRepository(replayClient, { now: () => new Date(NOW) });
  const replay = await replayRepo.createMemoryCandidate({ sessionId: existing.session_id as string, candidateText: existing.candidate_text as string });
  assert.equal(replay.created, false);
  assert.equal(replay.memoryCandidate.status, 'accepted');
  assert.equal(replay.memoryCandidate.confidence, undefined);

  const listClient = new ScriptedSqlClient();
  listClient.enqueue(one({ session: sessionRow() }));
  listClient.enqueue({ rows: [{ memory_candidate: existing }], rowCount: 1 });
  const listRepo = new PostgreSqlRepository(listClient, { now: () => new Date(NOW) });
  const list = await listRepo.listMemoryCandidates(existing.session_id as string);
  assert.deepEqual(list.map((candidate) => candidate.id), [existing.id]);
  assert.deepEqual(listClient.calls.map((call) => call.sql), [PostgreSqlStatements.findSessionById, PostgreSqlStatements.listMemoryCandidatesBySession]);
});

test('PostgreSqlRepository updates memory candidate status and recovers unique race by re-reading', async () => {
  const statusClient = new ScriptedSqlClient();
  statusClient.enqueue(one({ memory_candidate: memoryCandidateRow({ status: 'rejected', reason: 'stale' }) }));
  const statusRepo = new PostgreSqlRepository(statusClient, { now: () => new Date(NOW) });
  const updated = await statusRepo.setMemoryCandidateStatus({ memoryCandidateId: '00000000-0000-4000-8000-000000001301', status: 'rejected', reason: ' stale ' });
  assert.equal(updated.memoryCandidate.status, 'rejected');
  assert.equal(statusClient.calls[0]?.params?.[1], 'rejected');
  assert.equal(statusClient.calls[0]?.params?.[2], 'stale');

  const raceClient = new ScriptedSqlClient();
  const unique = Object.assign(new Error('duplicate'), { code: '23505' });
  raceClient.enqueue(none());
  raceClient.enqueue(one({ session: sessionRow() }));
  raceClient.enqueue(unique);
  raceClient.enqueue(one({ memory_candidate: memoryCandidateRow() }));
  const raceRepo = new PostgreSqlRepository(raceClient, { now: () => new Date(NOW) });
  const race = await raceRepo.createMemoryCandidate({ sessionId: '00000000-0000-4000-8000-000000001201', candidateText: '用户喜欢简洁回复' });
  assert.equal(race.created, false);
  assert.deepEqual(raceClient.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findMemoryCandidateByNaturalKey,
    PostgreSqlStatements.findSessionById,
    PostgreSqlStatements.insertMemoryCandidate,
    'ROLLBACK',
    PostgreSqlStatements.findMemoryCandidateByNaturalKey,
  ]);
});

function memoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000001401',
    session_id: '00000000-0000-4000-8000-000000001201',
    memory_candidate_id: '00000000-0000-4000-8000-000000001301',
    entry_id: '00000000-0000-4000-8000-000000001101',
    source_event_id: '00000000-0000-4000-8000-000000001001',
    memory_text: '用户喜欢简洁回复',
    natural_key: 'candidate:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    reason: 'reviewed',
    confidence: '0.750',
    bridge_status: 'local',
    metadata: {},
    retention_class: 'memory',
    memory_space: 'default',
    source_system: 'agentlink',
    sensitivity: 'internal',
    promoted_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

test('PostgreSqlRepository promotes memory candidate into append-only memory', async () => {
  const client = new ScriptedSqlClient();
  const candidate = memoryCandidateRow({ status: 'pending', reason: 'manual' });
  client.enqueue(one({ memory_candidate: candidate }));
  client.enqueue(none());
  client.enqueue(one({ session: sessionRow() }));
  client.enqueue(none());
  client.enqueue(one({ memory_candidate: memoryCandidateRow({ status: 'accepted', reason: 'reviewed' }) }));
  client.enqueue(one({ memory: memoryRow({ reason: 'reviewed' }) }));
  const repo = new PostgreSqlRepository(client, { now: () => new Date(NOW) });

  const result = await repo.promoteMemoryCandidate({ memoryCandidateId: candidate.id as string, reason: ' reviewed ' });
  assert.equal(result.created, true);
  assert.equal(result.memory.memoryCandidateId, candidate.id);
  assert.equal(result.memory.retentionClass, 'memory');
  assert.equal(result.memory.bridgeStatus, 'local');
  assert.equal(result.memoryCandidate.status, 'accepted');
  assert.deepEqual(client.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findMemoryCandidateById,
    PostgreSqlStatements.findMemoryByCandidateId,
    PostgreSqlStatements.findSessionById,
    PostgreSqlStatements.findMemoryByNaturalKey,
    PostgreSqlStatements.updateMemoryCandidateStatus,
    PostgreSqlStatements.insertMemory,
    'COMMIT',
  ]);
  assert.equal(client.calls[6]?.params?.[5], '用户喜欢简洁回复');
  assert.equal(client.calls[6]?.params?.[6], candidate.natural_key);
  assert.equal(client.calls[6]?.params?.[10], 'memory');
});

test('PostgreSqlRepository replays and lists promoted memories', async () => {
  const existing = memoryRow({ confidence: null });
  const replayClient = new ScriptedSqlClient();
  replayClient.enqueue(one({ memory_candidate: memoryCandidateRow({ status: 'accepted' }) }));
  replayClient.enqueue(one({ memory: existing }));
  const replayRepo = new PostgreSqlRepository(replayClient, { now: () => new Date(NOW) });
  const replay = await replayRepo.promoteMemoryCandidate({ memoryCandidateId: existing.memory_candidate_id as string });
  assert.equal(replay.created, false);
  assert.equal(replay.memory.id, existing.id);
  assert.equal(replay.memory.confidence, undefined);

  const listClient = new ScriptedSqlClient();
  listClient.enqueue(one({ session: sessionRow() }));
  listClient.enqueue({ rows: [{ memory: existing }], rowCount: 1 });
  const listRepo = new PostgreSqlRepository(listClient, { now: () => new Date(NOW) });
  const list = await listRepo.listMemories(existing.session_id as string);
  assert.deepEqual(list.map((memory) => memory.id), [existing.id]);
  assert.deepEqual(listClient.calls.map((call) => call.sql), [PostgreSqlStatements.findSessionById, PostgreSqlStatements.listMemoriesBySession]);
});

test('PostgreSqlRepository rejects rejected candidate and recovers memory unique race by re-reading', async () => {
  const rejectedClient = new ScriptedSqlClient();
  rejectedClient.enqueue(one({ memory_candidate: memoryCandidateRow({ status: 'rejected' }) }));
  rejectedClient.enqueue(none());
  const rejectedRepo = new PostgreSqlRepository(rejectedClient, { now: () => new Date(NOW) });
  await assert.rejects(
    () => rejectedRepo.promoteMemoryCandidate({ memoryCandidateId: '00000000-0000-4000-8000-000000001301' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST',
  );
  assert.deepEqual(rejectedClient.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findMemoryCandidateById,
    PostgreSqlStatements.findMemoryByCandidateId,
    'ROLLBACK',
  ]);

  const raceClient = new ScriptedSqlClient();
  const unique = Object.assign(new Error('duplicate'), { code: '23505' });
  raceClient.enqueue(one({ memory_candidate: memoryCandidateRow({ status: 'pending' }) }));
  raceClient.enqueue(none());
  raceClient.enqueue(one({ session: sessionRow() }));
  raceClient.enqueue(none());
  raceClient.enqueue(one({ memory_candidate: memoryCandidateRow({ status: 'accepted' }) }));
  raceClient.enqueue(unique);
  raceClient.enqueue(one({ memory_candidate: memoryCandidateRow({ status: 'accepted' }) }));
  raceClient.enqueue(one({ memory: memoryRow() }));
  const raceRepo = new PostgreSqlRepository(raceClient, { now: () => new Date(NOW) });
  const race = await raceRepo.promoteMemoryCandidate({ memoryCandidateId: '00000000-0000-4000-8000-000000001301' });
  assert.equal(race.created, false);
  assert.deepEqual(raceClient.calls.map((call) => call.sql), [
    'BEGIN',
    PostgreSqlStatements.findMemoryCandidateById,
    PostgreSqlStatements.findMemoryByCandidateId,
    PostgreSqlStatements.findSessionById,
    PostgreSqlStatements.findMemoryByNaturalKey,
    PostgreSqlStatements.updateMemoryCandidateStatus,
    PostgreSqlStatements.insertMemory,
    'ROLLBACK',
    'BEGIN',
    PostgreSqlStatements.findMemoryCandidateById,
    PostgreSqlStatements.findMemoryByCandidateId,
    'COMMIT',
  ]);
});
