import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { DEFAULT_WORKSPACE } from '../src/control-plane/in-memory.js';
import { createAgentlinkServer, createAgentlinkServerFromConfig } from '../src/server.js';


async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createAgentlinkServer({ name: 'agentlink-test', version: '0.1.0-test', environment: 'test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);

  try {
    await run(`http://127.0.0.1:${(address as { port: number }).port}`);
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function postJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('health, ready, and meta endpoints return service metadata', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'agentlink-test', version: '0.1.0-test' });

    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, service: 'agentlink-test', environment: 'test' });

    const meta = await fetch(`${baseUrl}/api/v1/meta`);
    assert.equal(meta.status, 200);
    const body = (await meta.json()) as { m1Scope: string; capabilities: string[] };
    assert.equal(body.m1Scope, 'personal:telegram-agentlink-claw-tenc-codex');
    assert.equal(body.capabilities.includes('agentlet-pull'), true);
  });
});

test('configured server keeps memory mode default and requires DSN for PostgreSQL mode', async () => {
  const server = createAgentlinkServerFromConfig({
    host: '127.0.0.1',
    port: 0,
    serviceName: 'agentlink-test',
    environment: 'test',
    storage: 'memory',
    databasePoolMax: 1,
    databaseIdleTimeoutMs: 1_000,
    databaseConnectionTimeoutMs: 1_000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  try {
    const health = await fetch(`http://127.0.0.1:${(address as { port: number }).port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await closeServer(server);
  }

  assert.throws(
    () =>
      createAgentlinkServerFromConfig({
        host: '127.0.0.1',
        port: 0,
        serviceName: 'agentlink-test',
        environment: 'test',
        storage: 'postgres',
        databasePoolMax: 1,
        databaseIdleTimeoutMs: 1_000,
        databaseConnectionTimeoutMs: 1_000,
      }),
    /AGENTLINK_DATABASE_URL is required/,
  );
});

test('HTTP M1 control-plane loop creates a task, leases it to an agentlet, and completes it', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc',
      owner_user_id: 'whiteParachute',
      agentlet_version: 'test-agentlet',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    assert.equal(register.status, 201);
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string };
    const auth = { authorization: `Bearer ${registered.device_secret}` };

    const heartbeat = await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);
    assert.equal(heartbeat.status, 200);

    const taskResponse = await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:chat:msg', payload: { text: 'run codex smoke' } },
      { 'idempotency-key': 'telegram:chat:msg' },
    );
    assert.equal(taskResponse.status, 201);
    const task = (await taskResponse.json()) as { task_id: string; current_run_id: string; task_status: string; run_status: string };
    assert.equal(task.task_status, 'QUEUED');
    assert.equal(task.run_status, 'QUEUED');

    const pull = await postJson(
      baseUrl,
      '/api/v1/agentlet/pull',
      { device_id: registered.device_id, runner_id: registered.runner_id, supported_capabilities: ['codex:exec'] },
      auth,
    );
    assert.equal(pull.status, 200);
    const pulled = (await pull.json()) as { run_id: string; lease_id: string; instruction: { prompt: string } };
    assert.equal(pulled.run_id, task.current_run_id);
    assert.equal(pulled.instruction.prompt, 'run codex smoke');

    const duplicatePull = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: registered.device_id, runner_id: registered.runner_id }, auth);
    assert.equal(duplicatePull.status, 204);

    const ack = await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth);
    assert.equal(ack.status, 200);
    assert.equal(((await ack.json()) as { run: { status: string } }).run.status, 'RUNNING');

    const progress = await postJson(
      baseUrl,
      '/api/v1/agentlet/progress',
      { device_id: registered.device_id, run_id: pulled.run_id, lease_id: pulled.lease_id, seq: 1, event_type: 'STDOUT', payload: { text: 'hello' } },
      auth,
    );
    assert.equal(progress.status, 200);

    const complete = await postJson(
      baseUrl,
      '/api/v1/agentlet/complete',
      { device_id: registered.device_id, run_id: pulled.run_id, lease_id: pulled.lease_id, status: 'SUCCEEDED', result: { text: 'done' } },
      auth,
    );
    assert.equal(complete.status, 200);
    assert.equal(((await complete.json()) as { task: { status: string }; run: { status: string } }).task.status, 'SUCCEEDED');

    const taskGet = await fetch(`${baseUrl}/api/v1/tasks/${task.task_id}`);
    assert.equal(taskGet.status, 200);
    assert.equal(((await taskGet.json()) as { task: { status: string } }).task.status, 'SUCCEEDED');

    const events = await fetch(`${baseUrl}/api/v1/runs/${pulled.run_id}/events?after_seq=0`);
    assert.equal(events.status, 200);
    const eventsBody = (await events.json()) as { events: Array<{ event_type: string; eventType?: string; seq: number }> };
    assert.equal(eventsBody.events.some((event) => event.event_type === 'STDOUT' && event.seq === 1), true);
    assert.equal(eventsBody.events.some((event) => event.eventType !== undefined), false);
  });
});

test('agentlet endpoints require the matching device token', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: 'missing', runner_id: 'runner' });
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'AL_AUTH_REQUIRED');
  });
});


test('HTTP API rejects unacked progress and keeps external DTOs snake_case', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc',
      owner_user_id: 'whiteParachute',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string; device?: Record<string, unknown> };
    assert.equal(JSON.stringify(registered).includes('token_hash'), false);
    const auth = { authorization: `Bearer ${registered.device_secret}` };
    await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);
    const taskResponse = await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:chat:unacked', payload: { text: 'run codex smoke' } },
      { 'idempotency-key': 'telegram:chat:unacked' },
    );
    assert.equal(taskResponse.status, 201);
    const pull = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: registered.device_id, runner_id: registered.runner_id }, auth);
    const pulled = (await pull.json()) as { run_id: string; lease_id: string };

    const progress = await postJson(
      baseUrl,
      '/api/v1/agentlet/progress',
      { device_id: registered.device_id, run_id: pulled.run_id, lease_id: pulled.lease_id, seq: 1, event_type: 'STDOUT' },
      auth,
    );
    assert.equal(progress.status, 409);
    assert.equal(((await progress.json()) as { error: { code: string } }).error.code, 'AL_STATE_CONFLICT');

    const complete = await postJson(
      baseUrl,
      '/api/v1/agentlet/complete',
      { device_id: registered.device_id, run_id: pulled.run_id, lease_id: pulled.lease_id, status: 'SUCCEEDED' },
      auth,
    );
    assert.equal(complete.status, 409);
    assert.equal(((await complete.json()) as { error: { code: string } }).error.code, 'AL_STATE_CONFLICT');

    const stringAccepted = await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: 'false' }, auth);
    assert.equal(stringAccepted.status, 400);
    assert.equal(((await stringAccepted.json()) as { error: { code: string } }).error.code, 'AL_BAD_REQUEST');

    const ack = await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth);
    const ackBody = (await ack.json()) as { lease: { run_id: string; runId?: string; issued_at: string; issuedAt?: string } };
    assert.equal(ack.status, 200);
    assert.equal(ackBody.lease.run_id, pulled.run_id);
    assert.equal(ackBody.lease.runId, undefined);
    assert.equal(typeof ackBody.lease.issued_at, 'string');
    assert.equal(ackBody.lease.issuedAt, undefined);
  });
});

test('agentlet lease operations reject wrong tokens and cross-device lease access', async () => {
  await withServer(async (baseUrl) => {
    const aRegister = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc-a',
      owner_user_id: 'whiteParachute',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    const a = (await aRegister.json()) as { device_id: string; runner_id: string; device_secret: string };
    const bRegister = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc-b',
      owner_user_id: 'whiteParachute',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    const b = (await bRegister.json()) as { device_id: string; runner_id: string; device_secret: string };
    const authA = { authorization: `Bearer ${a.device_secret}` };
    const authB = { authorization: `Bearer ${b.device_secret}` };
    await postJson(baseUrl, `/api/v1/devices/${a.device_id}/heartbeat`, {}, authA);
    await postJson(baseUrl, `/api/v1/devices/${b.device_id}/heartbeat`, {}, authB);
    await postJson(baseUrl, '/api/v1/tasks', { source: 'telegram', source_ref: 'telegram:chat:cross', payload: { text: 'run' } }, { 'idempotency-key': 'telegram:chat:cross' });
    const pull = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: a.device_id, runner_id: a.runner_id }, authA);
    const pulled = (await pull.json()) as { lease_id: string };

    const wrongToken = await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: a.device_id, lease_id: pulled.lease_id, accepted: true }, { authorization: `Bearer ${b.device_secret}` });
    assert.equal(wrongToken.status, 401);
    assert.equal(((await wrongToken.json()) as { error: { code: string } }).error.code, 'AL_AUTH_INVALID');

    const crossDevice = await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: b.device_id, lease_id: pulled.lease_id, accepted: true }, authB);
    assert.equal(crossDevice.status, 403);
    assert.equal(((await crossDevice.json()) as { error: { code: string } }).error.code, 'AL_RUN_001');
  });
});

test('HTTP agentlet pull returns policy errors for missing grants', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc',
      owner_user_id: 'whiteParachute',
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    assert.equal(register.status, 201);
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string };
    const auth = { authorization: `Bearer ${registered.device_secret}` };
    await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);
    await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:policy:missing-cap', payload: { text: 'run' } },
      { 'idempotency-key': 'telegram:policy:missing-cap' },
    );

    const pull = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: registered.device_id, runner_id: registered.runner_id }, auth);
    assert.equal(pull.status, 403);
    assert.equal(((await pull.json()) as { error: { code: string } }).error.code, 'AL_CAPABILITY_DENIED');
  });
});

test('malformed JSON returns AL_BAD_JSON instead of internal error', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'AL_BAD_JSON');
  });
});

test('HTTP cancel publishes control_actions and recover returns active leases only', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc',
      owner_user_id: 'whiteParachute',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    assert.equal(register.status, 201);
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string };
    const auth = { authorization: `Bearer ${registered.device_secret}` };
    await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);

    const taskResponse = await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:chat:cancel', payload: { text: 'cancel me' } },
      { 'idempotency-key': 'telegram:chat:cancel' },
    );
    assert.equal(taskResponse.status, 201);
    const task = (await taskResponse.json()) as { task_id: string };

    const pull = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: registered.device_id, runner_id: registered.runner_id }, auth);
    assert.equal(pull.status, 200);
    const pulled = (await pull.json()) as { run_id: string; lease_id: string };
    const ack = await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth);
    assert.equal(ack.status, 200);
    const renew = await postJson(baseUrl, '/api/v1/agentlet/lease/renew', { device_id: registered.device_id, lease_id: pulled.lease_id }, auth);
    assert.equal(renew.status, 200);
    const renewed = (await renew.json()) as { lease: { status: string; renewed_at?: string }; control_actions: unknown[] };
    assert.equal(renewed.lease.status, 'RENEWED');
    assert.equal(typeof renewed.lease.renewed_at, 'string');
    assert.deepEqual(renewed.control_actions, []);

    const recoverBeforeCancel = await postJson(baseUrl, '/api/v1/agentlet/recover', { device_id: registered.device_id }, auth);
    assert.equal(recoverBeforeCancel.status, 200);
    const recoverBeforeBody = (await recoverBeforeCancel.json()) as { recoverable_runs: Array<{ run_id: string; task_id: string; lease_id: string; run_status: string; lease_status: string; instruction: { prompt?: string }; expires_at: string }> };
    assert.equal(recoverBeforeBody.recoverable_runs.length, 1);
    assert.equal(recoverBeforeBody.recoverable_runs[0]?.run_id, pulled.run_id);
    assert.equal(recoverBeforeBody.recoverable_runs[0]?.task_id, task.task_id);
    assert.equal(recoverBeforeBody.recoverable_runs[0]?.lease_id, pulled.lease_id);
    assert.equal(recoverBeforeBody.recoverable_runs[0]?.run_status, 'RUNNING');
    assert.equal(recoverBeforeBody.recoverable_runs[0]?.lease_status, 'RENEWED');
    assert.equal(recoverBeforeBody.recoverable_runs[0]?.instruction.prompt, 'cancel me');
    assert.equal(typeof recoverBeforeBody.recoverable_runs[0]?.expires_at, 'string');

    const continueRecovery = await postJson(baseUrl, '/api/v1/agentlet/recover/decision', { device_id: registered.device_id, lease_id: pulled.lease_id, decision: 'continue' }, auth);
    assert.equal(continueRecovery.status, 200);
    assert.equal(((await continueRecovery.json()) as { decision: string; lease: { status: string }; retry_run: null }).decision, 'continue');

    const cancel = await postJson(baseUrl, `/api/v1/tasks/${task.task_id}/cancel`, { reason: 'user_cancelled' });
    assert.equal(cancel.status, 200);
    const cancelled = (await cancel.json()) as { task: { status: string }; run: { status: string }; lease: { status: string }; control_actions: Array<{ action_id: string; type: string; device_id: string; run_id: string; lease_id: string; reason: string; status: string; runId?: string }> };
    assert.equal(cancelled.task.status, 'CANCELLED');
    assert.equal(cancelled.run.status, 'CANCELLED');
    assert.equal(cancelled.lease.status, 'CANCELLED');
    assert.equal(cancelled.control_actions.length, 1);
    assert.equal(cancelled.control_actions[0]?.type, 'cancel_run');
    assert.equal(cancelled.control_actions[0]?.device_id, registered.device_id);
    assert.equal(cancelled.control_actions[0]?.run_id, pulled.run_id);
    assert.equal(cancelled.control_actions[0]?.lease_id, pulled.lease_id);
    assert.equal(cancelled.control_actions[0]?.reason, 'user_cancelled');
    assert.equal(cancelled.control_actions[0]?.status, 'PENDING');
    assert.equal(cancelled.control_actions.some((action) => action.runId !== undefined), false);

    const poll = await postJson(baseUrl, '/api/v1/agentlet/control/poll', { device_id: registered.device_id }, auth);
    assert.equal(poll.status, 200);
    assert.deepEqual((await poll.json()) as { control_actions: unknown[] }, { control_actions: cancelled.control_actions });

    const controlAck = await postJson(baseUrl, '/api/v1/agentlet/control/ack', { device_id: registered.device_id, action_id: cancelled.control_actions[0]?.action_id }, auth);
    assert.equal(controlAck.status, 200);
    assert.equal(((await controlAck.json()) as { control_action: { status: string } }).control_action.status, 'ACKED');
    const pollAfterAck = await postJson(baseUrl, '/api/v1/agentlet/control/poll', { device_id: registered.device_id }, auth);
    assert.equal(pollAfterAck.status, 200);
    assert.deepEqual(await pollAfterAck.json(), { control_actions: [] });

    const recoverAfterCancel = await postJson(baseUrl, '/api/v1/agentlet/recover', { device_id: registered.device_id }, auth);
    assert.equal(recoverAfterCancel.status, 200);
    assert.deepEqual(await recoverAfterCancel.json(), { recoverable_runs: [] });
  });
});

test('HTTP recover discard expires the lease and returns a retry run when allowed', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc',
      owner_user_id: 'whiteParachute',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    assert.equal(register.status, 201);
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string };
    const auth = { authorization: `Bearer ${registered.device_secret}` };
    await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);
    const taskResponse = await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:chat:recover-discard', payload: { text: 'discard me' } },
      { 'idempotency-key': 'telegram:chat:recover-discard' },
    );
    assert.equal(taskResponse.status, 201);
    const task = (await taskResponse.json()) as { current_run_id: string };
    const pull = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: registered.device_id, runner_id: registered.runner_id }, auth);
    assert.equal(pull.status, 200);
    const pulled = (await pull.json()) as { lease_id: string };
    const ack = await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth);
    assert.equal(ack.status, 200);

    const discard = await postJson(
      baseUrl,
      '/api/v1/agentlet/recover/decision',
      { device_id: registered.device_id, lease_id: pulled.lease_id, decision: 'discard', reason: 'lost_process' },
      auth,
    );
    assert.equal(discard.status, 200);
    const discarded = (await discard.json()) as { decision: string; lease: { status: string; expire_reason: string }; run: { status: string }; task: { status: string; retry_count: number; current_run_id: string }; retry_run: { id: string; attempt_no: number } | null };
    assert.equal(discarded.decision, 'discard');
    assert.equal(discarded.lease.status, 'EXPIRED');
    assert.equal(discarded.lease.expire_reason, 'lost_process');
    assert.equal(discarded.run.status, 'TIMED_OUT');
    assert.equal(discarded.task.status, 'QUEUED');
    assert.equal(discarded.task.retry_count, 1);
    assert.ok(discarded.retry_run);
    assert.equal(discarded.retry_run?.attempt_no, 2);
    assert.notEqual(discarded.task.current_run_id, task.current_run_id);
  });
});
