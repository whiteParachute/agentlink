import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createAgentlinkServer } from '../src/server.js';

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

test('HTTP M1 control-plane loop creates a task, leases it to an agentlet, and completes it', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc',
      owner_user_id: 'whiteParachute',
      agentlet_version: 'test-agentlet',
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
    const register = await postJson(baseUrl, '/api/v1/devices/register', { display_name: 'claw-tenc', owner_user_id: 'whiteParachute' });
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
    const aRegister = await postJson(baseUrl, '/api/v1/devices/register', { display_name: 'claw-tenc-a', owner_user_id: 'whiteParachute' });
    const a = (await aRegister.json()) as { device_id: string; runner_id: string; device_secret: string };
    const bRegister = await postJson(baseUrl, '/api/v1/devices/register', { display_name: 'claw-tenc-b', owner_user_id: 'whiteParachute' });
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

test('malformed JSON returns AL_BAD_JSON instead of internal error', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'AL_BAD_JSON');
  });
});
