import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { DEFAULT_WORKSPACE } from '../src/control-plane/in-memory.js';
import { createAgentlinkServer, createAgentlinkServerFromConfig, type AgentlinkServerOptions } from '../src/server.js';


async function withServer(run: (baseUrl: string) => Promise<void>, options: AgentlinkServerOptions = {}): Promise<void> {
  const server = createAgentlinkServer({ name: 'agentlink-test', version: '0.1.0-test', environment: 'test' }, options);
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

async function patchJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
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

test('HTTP grant management APIs add and revoke grants with snake_case DTOs', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'claw-tenc',
      owner_user_id: 'whiteParachute',
    });
    assert.equal(register.status, 201);
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string };

    const capabilityCreate = await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/capability-grants`, {
      runner_id: registered.runner_id,
      capability: 'codex:exec',
      granted_by: 'operator',
    });
    assert.equal(capabilityCreate.status, 201);
    const capabilityBody = (await capabilityCreate.json()) as { capability_grant: { id: string; device_id: string; runner_id: string; grant_status: string; granted_by: string; deviceId?: string } };
    assert.equal(capabilityBody.capability_grant.device_id, registered.device_id);
    assert.equal(capabilityBody.capability_grant.runner_id, registered.runner_id);
    assert.equal(capabilityBody.capability_grant.grant_status, 'GRANTED');
    assert.equal(capabilityBody.capability_grant.granted_by, 'operator');
    assert.equal(capabilityBody.capability_grant.deviceId, undefined);

    const capabilityList = await fetch(`${baseUrl}/api/v1/devices/${registered.device_id}/capability-grants`);
    assert.equal(capabilityList.status, 200);
    assert.equal(((await capabilityList.json()) as { capability_grants: unknown[] }).capability_grants.length, 1);

    const workdirCreate = await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/workdir-grants`, {
      path_prefix: DEFAULT_WORKSPACE,
      access_mode: 'read_write',
    });
    assert.equal(workdirCreate.status, 201);
    const workdirBody = (await workdirCreate.json()) as { workdir_grant: { id: string; device_id: string; path_prefix: string; access_mode: string; pathPrefix?: string } };
    assert.equal(workdirBody.workdir_grant.device_id, registered.device_id);
    assert.equal(workdirBody.workdir_grant.path_prefix, DEFAULT_WORKSPACE);
    assert.equal(workdirBody.workdir_grant.access_mode, 'read_write');
    assert.equal(workdirBody.workdir_grant.pathPrefix, undefined);

    const workdirList = await fetch(`${baseUrl}/api/v1/devices/${registered.device_id}/workdir-grants`);
    assert.equal(workdirList.status, 200);
    assert.equal(((await workdirList.json()) as { workdir_grants: unknown[] }).workdir_grants.length, 1);

    const revokeCapability = await postJson(baseUrl, `/api/v1/capability-grants/${capabilityBody.capability_grant.id}/revoke`, {});
    assert.equal(revokeCapability.status, 200);
    assert.equal(((await revokeCapability.json()) as { capability_grant: { grant_status: string; revoked_at?: string } }).capability_grant.grant_status, 'REVOKED');

    const auth = { authorization: `Bearer ${registered.device_secret}` };
    await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);
    await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:grant-revoked', payload: { text: 'should deny after grant revoke' } },
      { 'idempotency-key': 'telegram:grant-revoked' },
    );
    const pullAfterCapabilityRevoke = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: registered.device_id, runner_id: registered.runner_id }, auth);
    assert.equal(pullAfterCapabilityRevoke.status, 403);
    assert.equal(((await pullAfterCapabilityRevoke.json()) as { error: { code: string } }).error.code, 'AL_CAPABILITY_DENIED');

    const revokeWorkdir = await postJson(baseUrl, `/api/v1/workdir-grants/${workdirBody.workdir_grant.id}/revoke`, {});
    assert.equal(revokeWorkdir.status, 200);
    assert.equal(typeof ((await revokeWorkdir.json()) as { workdir_grant: { revoked_at?: string } }).workdir_grant.revoked_at, 'string');
  });
});

test('HTTP device revoke cascades active work and revokes token', async () => {
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
    await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:device-revoke', payload: { text: 'cancel by revoke' } },
      { 'idempotency-key': 'telegram:device-revoke' },
    );
    const pull = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: registered.device_id, runner_id: registered.runner_id }, auth);
    assert.equal(pull.status, 200);
    const pulled = (await pull.json()) as { lease_id: string };
    assert.equal((await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth)).status, 200);

    const revoke = await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/revoke`, { reason: 'operator_revoked' });
    assert.equal(revoke.status, 200);
    const revoked = (await revoke.json()) as { device: { status: string; revoked_at?: string }; tasks: Array<{ status: string }>; runs: Array<{ status: string }>; leases: Array<{ status: string; expire_reason: string }> };
    assert.equal(revoked.device.status, 'REVOKED');
    assert.equal(typeof revoked.device.revoked_at, 'string');
    assert.equal(revoked.tasks[0]?.status, 'CANCELLED');
    assert.equal(revoked.runs[0]?.status, 'CANCELLED');
    assert.equal(revoked.leases[0]?.status, 'CANCELLED');
    assert.equal(revoked.leases[0]?.expire_reason, 'operator_revoked');

    const pollAfterRevoke = await postJson(baseUrl, '/api/v1/agentlet/control/poll', { device_id: registered.device_id }, auth);
    assert.equal(pollAfterRevoke.status, 401);
    assert.equal(((await pollAfterRevoke.json()) as { error: { code: string } }).error.code, 'AL_TOKEN_REVOKED');
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

test('HTTP recover continue requires an acknowledged running lease', async () => {
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
      { source: 'telegram', source_ref: 'telegram:chat:recover-unacked', payload: { text: 'recover unacked' } },
      { 'idempotency-key': 'telegram:chat:recover-unacked' },
    );
    assert.equal(taskResponse.status, 201);
    const pull = await postJson(baseUrl, '/api/v1/agentlet/pull', { device_id: registered.device_id, runner_id: registered.runner_id }, auth);
    assert.equal(pull.status, 200);
    const pulled = (await pull.json()) as { lease_id: string };

    const unackedContinue = await postJson(
      baseUrl,
      '/api/v1/agentlet/recover/decision',
      { device_id: registered.device_id, lease_id: pulled.lease_id, decision: 'continue' },
      auth,
    );
    assert.equal(unackedContinue.status, 409);
    assert.equal(((await unackedContinue.json()) as { error: { code: string } }).error.code, 'AL_STATE_CONFLICT');

    const ack = await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth);
    assert.equal(ack.status, 200);
    const acknowledgedContinue = await postJson(
      baseUrl,
      '/api/v1/agentlet/recover/decision',
      { device_id: registered.device_id, lease_id: pulled.lease_id, decision: 'continue' },
      auth,
    );
    assert.equal(acknowledgedContinue.status, 200);
    assert.equal(((await acknowledgedContinue.json()) as { decision: string; lease: { status: string }; run: { status: string } }).lease.status, 'RENEWED');
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

test('HTTP task endpoint accepts snake_case retention and returns it in response', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(
      baseUrl,
      '/api/v1/tasks',
      {
        source: 'telegram',
        source_ref: 'telegram:chat:ret1',
        payload: { text: 'hi' },
        retention: {
          retention_class: 'memory_candidate',
          sensitivity: 'confidential',
          memory_space: 'work.projectx',
          source_system: 'telegram',
        },
      },
      { 'idempotency-key': 'ret-http-1' },
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as { task: { retention: Record<string, string> }; run: { retention: Record<string, string> } };
    assert.equal(body.task.retention.retention_class, 'memory_candidate');
    assert.equal(body.task.retention.sensitivity, 'confidential');
    assert.equal(body.task.retention.memory_space, 'work.projectx');
    assert.equal(body.task.retention.source_system, 'telegram');
    assert.equal(body.run.retention.retention_class, 'memory_candidate');
    assert.equal(body.run.retention.memory_space, 'work.projectx');
  });
});

test('HTTP task response includes default retention when none is provided', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:chat:ret2', payload: { text: 'hi' } },
      { 'idempotency-key': 'ret-http-default' },
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as { task: { retention: Record<string, string> } };
    assert.equal(body.task.retention.retention_class, 'operational');
    assert.equal(body.task.retention.sensitivity, 'internal');
    assert.equal(body.task.retention.memory_space, 'default');
    assert.equal(body.task.retention.source_system, 'agentlink');
  });
});

test('HTTP agentlet progress accepts snake_case retention and returns it', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'ret-test',
      owner_user_id: 'test',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string };
    const auth = { authorization: `Bearer ${registered.device_secret}` };
    await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);

    const taskResp = await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'http', source_ref: 'ret-progress', payload: { text: 'go' } },
      { 'idempotency-key': 'ret-progress-key' },
    );
    const taskBody = (await taskResp.json()) as { task_id: string; current_run_id: string };

    const pullResp = await postJson(
      baseUrl,
      '/api/v1/agentlet/pull',
      { device_id: registered.device_id, runner_id: registered.runner_id, supported_capabilities: ['codex:exec'] },
      auth,
    );
    const pulled = (await pullResp.json()) as { run_id: string; lease_id: string };
    await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth);

    const progResp = await postJson(
      baseUrl,
      '/api/v1/agentlet/progress',
      {
        device_id: registered.device_id,
        run_id: pulled.run_id,
        lease_id: pulled.lease_id,
        seq: 1,
        event_type: 'STDOUT',
        payload: { text: 'hello' },
        retention: { retention_class: 'artifact', sensitivity: 'public' },
      },
      auth,
    );
    assert.equal(progResp.status, 200);
    const progBody = (await progResp.json()) as { event: { retention: Record<string, string> } };
    assert.equal(progBody.event.retention.retention_class, 'artifact');
    assert.equal(progBody.event.retention.sensitivity, 'public');
    assert.equal(progBody.event.retention.source_system, 'agentlet');

    // Verify GET /runs/:id/events returns retention
    const eventsResp = await fetch(`${baseUrl}/api/v1/runs/${taskBody.current_run_id}/events`);
    const eventsBody = (await eventsResp.json()) as { events: Array<{ retention: Record<string, string> }> };
    assert.equal(eventsBody.events[0]?.retention.retention_class, 'artifact');
  });
});

test('HTTP task creation returns 400 for invalid retention_class', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(
      baseUrl,
      '/api/v1/tasks',
      {
        source: 'telegram',
        source_ref: 'telegram:chat:badret',
        payload: { text: 'hi' },
        retention: { retention_class: 'bogus' },
      },
      { 'idempotency-key': 'ret-bad-class' },
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string; field?: string; message: string } };
    assert.equal(body.error.code, 'AL_BAD_REQUEST');
    assert.equal(body.error.field, 'retention_class');
  });
});

test('HTTP task creation returns 400 for invalid sensitivity', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(
      baseUrl,
      '/api/v1/tasks',
      {
        source: 'telegram',
        source_ref: 'telegram:chat:badsens',
        payload: { text: 'hi' },
        retention: { sensitivity: 'top_secret' },
      },
      { 'idempotency-key': 'ret-bad-sens' },
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string; field?: string } };
    assert.equal(body.error.field, 'sensitivity');
  });
});

test('HTTP task creation returns 400 for invalid memory_space', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(
      baseUrl,
      '/api/v1/tasks',
      {
        source: 'telegram',
        source_ref: 'telegram:chat:badmem',
        payload: { text: 'hi' },
        retention: { memory_space: 'has space' },
      },
      { 'idempotency-key': 'ret-bad-mem' },
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { field?: string } };
    assert.equal(body.error.field, 'memory_space');
  });
});

test('HTTP agentlet progress returns 400 for invalid source_system', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'ret-src-test',
      owner_user_id: 'test',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string };
    const auth = { authorization: `Bearer ${registered.device_secret}` };
    await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);

    await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'http', source_ref: 'ret-bad-src', payload: { text: 'go' } },
      { 'idempotency-key': 'ret-bad-src-key' },
    );

    const pullResp = await postJson(
      baseUrl,
      '/api/v1/agentlet/pull',
      { device_id: registered.device_id, runner_id: registered.runner_id },
      auth,
    );
    const pulled = (await pullResp.json()) as { run_id: string; lease_id: string };
    await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth);

    const progResp = await postJson(
      baseUrl,
      '/api/v1/agentlet/progress',
      {
        device_id: registered.device_id,
        run_id: pulled.run_id,
        lease_id: pulled.lease_id,
        seq: 1,
        event_type: 'STDOUT',
        retention: { source_system: 'bad system' },
      },
      auth,
    );
    assert.equal(progResp.status, 400);
    const body = (await progResp.json()) as { error: { field?: string } };
    assert.equal(body.error.field, 'source_system');
  });
});

test('HTTP idempotency replay works with omitted vs explicit default retention', async () => {
  await withServer(async (baseUrl) => {
    const first = await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:chat:replay', payload: { text: 'hi' } },
      { 'idempotency-key': 'ret-replay-key' },
    );
    assert.equal(first.status, 201);

    const replay = await postJson(
      baseUrl,
      '/api/v1/tasks',
      {
        source: 'telegram',
        source_ref: 'telegram:chat:replay',
        payload: { text: 'hi' },
        retention: {
          retention_class: 'operational',
          sensitivity: 'internal',
          memory_space: 'default',
          source_system: 'agentlink',
        },
      },
      { 'idempotency-key': 'ret-replay-key' },
    );
    assert.equal(replay.status, 200);
    const firstBody = (await first.json()) as { task_id: string };
    const replayBody = (await replay.json()) as { task_id: string };
    assert.equal(replayBody.task_id, firstBody.task_id);
  });
});

test('HTTP task API preserves raw payload alongside retention metadata (unique raw guard)', async () => {
  await withServer(async (baseUrl) => {
    const rawPayload = { text: 'raw user message', user_id: 12345, channel: 'private', extra: { nested: true } };
    const response = await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'telegram', source_ref: 'telegram:chat:raw-guard', payload: rawPayload },
      { 'idempotency-key': 'raw-guard-key' },
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      task: { payload: Record<string, unknown>; retention: Record<string, string> };
      run: { retention: Record<string, string> };
    };
    // Raw payload is preserved
    assert.deepEqual(body.task.payload, rawPayload);
    // Retention metadata is always present
    assert.equal(body.task.retention.retention_class, 'operational');
    assert.equal(body.task.retention.sensitivity, 'internal');
    assert.equal(body.task.retention.memory_space, 'default');
    assert.equal(body.task.retention.source_system, 'agentlink');
    // Run inherits retention from task
    assert.equal(body.run.retention.retention_class, 'operational');
  });
});

test('HTTP progress API preserves raw payload alongside retention metadata', async () => {
  await withServer(async (baseUrl) => {
    const register = await postJson(baseUrl, '/api/v1/devices/register', {
      display_name: 'raw-guard-device',
      owner_user_id: 'whiteParachute',
      agentlet_version: 'test-agentlet',
      capability_grants: ['codex:exec'],
      workdir_grants: [{ path_prefix: DEFAULT_WORKSPACE, access_mode: 'read_write' }],
    });
    assert.equal(register.status, 201);
    const registered = (await register.json()) as { device_id: string; runner_id: string; device_secret: string };
    const auth = { authorization: `Bearer ${registered.device_secret}` };

    await postJson(baseUrl, `/api/v1/devices/${registered.device_id}/heartbeat`, {}, auth);
    await postJson(
      baseUrl,
      '/api/v1/tasks',
      { source: 'http', source_ref: 'progress-raw-guard', payload: { text: 'go' } },
      { 'idempotency-key': 'progress-raw-guard-key' },
    );

    const pull = await postJson(
      baseUrl,
      '/api/v1/agentlet/pull',
      { device_id: registered.device_id, runner_id: registered.runner_id, supported_capabilities: ['codex:exec'] },
      auth,
    );
    assert.equal(pull.status, 200);
    const pulled = (await pull.json()) as { run_id: string; lease_id: string };
    await postJson(baseUrl, '/api/v1/agentlet/ack', { device_id: registered.device_id, lease_id: pulled.lease_id, accepted: true }, auth);

    const rawPayload = { text: 'raw stdout line', file_path: '/tmp/foo', line_no: 42 };
    const progResp = await postJson(
      baseUrl,
      '/api/v1/agentlet/progress',
      {
        device_id: registered.device_id,
        run_id: pulled.run_id,
        lease_id: pulled.lease_id,
        seq: 1,
        event_type: 'STDOUT',
        payload: rawPayload,
      },
      auth,
    );
    assert.equal(progResp.status, 200);
    const progBody = (await progResp.json()) as { event: { payload: Record<string, unknown>; retention: Record<string, string> } };
    assert.deepEqual(progBody.event.payload, rawPayload);
    assert.equal(progBody.event.retention.retention_class, 'short_term');
    assert.equal(progBody.event.retention.source_system, 'agentlet');
  });
});

test('GET /api/v1/main-user/profile returns 404 before initialization', async () => {
  await withServer(async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/v1/main-user/profile`);
    assert.equal(resp.status, 404);
    const body = (await resp.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'AL_MAIN_USER_NOT_FOUND');
  });
});

test('POST /api/v1/main-user/profile creates profile and returns 201', async () => {
  await withServer(async (baseUrl) => {
    const resp = await postJson(baseUrl, '/api/v1/main-user/profile', {
      display_name: 'Alice',
      locale: 'zh-CN',
      metadata: { theme: 'dark' },
    });
    assert.equal(resp.status, 201);
    const body = (await resp.json()) as { main_user: Record<string, unknown>; created: boolean };
    assert.equal(body.created, true);
    assert.equal(body.main_user.id, 'main');
    assert.equal(body.main_user.display_name, 'Alice');
    assert.equal(body.main_user.locale, 'zh-CN');
    assert.equal(body.main_user.timezone, 'Asia/Shanghai');
    assert.deepEqual(body.main_user.metadata, { theme: 'dark' });
    const retention = body.main_user.retention as Record<string, string>;
    assert.equal(retention.retention_class, 'operational');
    assert.equal(retention.memory_space, 'default');
    assert.equal(retention.source_system, 'agentlink');
    assert.equal(retention.sensitivity, 'internal');
  });
});

test('GET /api/v1/main-user/profile returns 200 after initialization', async () => {
  await withServer(async (baseUrl) => {
    await postJson(baseUrl, '/api/v1/main-user/profile', { display_name: 'Bob' });
    const resp = await fetch(`${baseUrl}/api/v1/main-user/profile`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { main_user: Record<string, unknown> };
    assert.equal(body.main_user.display_name, 'Bob');
    assert.ok(body.main_user.created_at);
    assert.ok(body.main_user.updated_at);
  });
});

test('second POST /api/v1/main-user/profile returns 200 and merges fields', async () => {
  await withServer(async (baseUrl) => {
    await postJson(baseUrl, '/api/v1/main-user/profile', { display_name: 'First', locale: 'en-US', metadata: { a: 1 } });
    const resp = await postJson(baseUrl, '/api/v1/main-user/profile', { display_name: 'Second' });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { main_user: Record<string, unknown>; created: boolean };
    assert.equal(body.created, false);
    assert.equal(body.main_user.display_name, 'Second');
    assert.equal(body.main_user.locale, 'en-US');
    assert.deepEqual(body.main_user.metadata, { a: 1 });
  });
});

test('POST /api/v1/main-user/profile accepts snake_case retention', async () => {
  await withServer(async (baseUrl) => {
    const resp = await postJson(baseUrl, '/api/v1/main-user/profile', {
      display_name: 'Alice',
      retention: { memory_space: 'personal', sensitivity: 'confidential' },
    });
    assert.equal(resp.status, 201);
    const body = (await resp.json()) as { main_user: { retention: Record<string, string> } };
    assert.equal(body.main_user.retention.memory_space, 'personal');
    assert.equal(body.main_user.retention.sensitivity, 'confidential');
  });
});

test('POST /api/v1/main-user/profile rejects invalid retention with 400', async () => {
  await withServer(async (baseUrl) => {
    const resp = await postJson(baseUrl, '/api/v1/main-user/profile', {
      display_name: 'Alice',
      retention: { retention_class: 'invalid_class' },
    });
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as { error: { code: string; field: string } };
    assert.equal(body.error.code, 'AL_BAD_REQUEST');
    assert.equal(body.error.field, 'retention_class');
  });
});

test('POST /api/v1/main-user/profile rejects empty display_name with 400', async () => {
  await withServer(async (baseUrl) => {
    const resp = await postJson(baseUrl, '/api/v1/main-user/profile', { display_name: '' });
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'AL_BAD_REQUEST');
  });
});

test('POST /api/v1/main-user/profile rejects non-object metadata with 400', async () => {
  await withServer(async (baseUrl) => {
    const resp = await postJson(baseUrl, '/api/v1/main-user/profile', {
      display_name: 'Alice',
      metadata: 'not-an-object',
    });
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'AL_BAD_REQUEST');
  });
});

test('HTTP channel user upsert repeats into same ChannelUser and returns snake_case DTOs', async () => {
  await withServer(async (baseUrl) => {
    const first = await postJson(baseUrl, '/api/v1/channel-users/upsert', {
      platform: ' Feishu ',
      external_id: ' Open-ID ',
      display_name: 'Alice',
      channel_user_metadata: { source: 'chat' },
      platform_identity_metadata: { chat: 'oc_1' },
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      created: boolean;
      channel_user: { id: string; display_name: string; category: string; retention: Record<string, string>; displayName?: string };
      platform_identity: { id: string; channel_user_id: string; platform: string; external_id: string; normalized_external_id: string; metadata: Record<string, unknown>; channelUserId?: string };
    };
    assert.equal(firstBody.created, true);
    assert.equal(firstBody.channel_user.display_name, 'Alice');
    assert.equal(firstBody.channel_user.displayName, undefined);
    assert.equal(firstBody.channel_user.category, 'unclassified');
    assert.equal(firstBody.channel_user.retention.retention_class, 'operational');
    assert.equal(firstBody.platform_identity.platform, 'feishu');
    assert.equal(firstBody.platform_identity.external_id, 'Open-ID');
    assert.equal(firstBody.platform_identity.normalized_external_id, 'Open-ID');
    assert.equal(firstBody.platform_identity.channelUserId, undefined);

    const replay = await postJson(baseUrl, '/api/v1/channel-users/upsert', {
      platform: 'feishu',
      external_id: 'Open-ID',
      display_name: 'Alice Updated',
      platform_identity_metadata: { chat: 'oc_2' },
    });
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as typeof firstBody;
    assert.equal(replayBody.created, false);
    assert.equal(replayBody.channel_user.id, firstBody.channel_user.id);
    assert.equal(replayBody.platform_identity.id, firstBody.platform_identity.id);
    assert.equal(replayBody.channel_user.display_name, 'Alice Updated');
    assert.deepEqual(replayBody.platform_identity.metadata, { chat: 'oc_2' });
  });
});

test('HTTP channel user category and platform identity resolve cover found/not found and validation', async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(baseUrl, '/api/v1/channel-users/upsert', {
      platform: 'telegram',
      external_id: 'User-1',
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { channel_user: { id: string } };

    const category = await patchJson(baseUrl, `/api/v1/channel-users/${body.channel_user.id}/category`, { category: 'family.child' });
    assert.equal(category.status, 200);
    assert.equal(((await category.json()) as { channel_user: { category: string } }).channel_user.category, 'family.child');

    const invalidCategory = await patchJson(baseUrl, `/api/v1/channel-users/${body.channel_user.id}/category`, { category: '-bad' });
    assert.equal(invalidCategory.status, 400);
    assert.equal(((await invalidCategory.json()) as { error: { code: string } }).error.code, 'AL_BAD_REQUEST');

    const missingCategory = await patchJson(baseUrl, '/api/v1/channel-users/missing/category', { category: 'family' });
    assert.equal(missingCategory.status, 404);
    assert.equal(((await missingCategory.json()) as { error: { code: string } }).error.code, 'AL_CHANNEL_USER_NOT_FOUND');

    const resolved = await fetch(`${baseUrl}/api/v1/platform-identities/resolve?platform=Telegram&external_id=User-1`);
    assert.equal(resolved.status, 200);
    const resolvedBody = (await resolved.json()) as { channel_user: { id: string }; platform_identity: { platform: string } };
    assert.equal(resolvedBody.channel_user.id, body.channel_user.id);
    assert.equal(resolvedBody.platform_identity.platform, 'telegram');

    const notFound = await fetch(`${baseUrl}/api/v1/platform-identities/resolve?platform=telegram&external_id=missing`);
    assert.equal(notFound.status, 404);
    assert.equal(((await notFound.json()) as { error: { code: string } }).error.code, 'AL_PLATFORM_IDENTITY_NOT_FOUND');

    const badQuery = await fetch(`${baseUrl}/api/v1/platform-identities/resolve?platform=telegram`);
    assert.equal(badQuery.status, 400);
    assert.equal(((await badQuery.json()) as { error: { code: string } }).error.code, 'AL_BAD_REQUEST');
  });
});

test('HTTP channel user upsert does not merge different platform or external_id', async () => {
  await withServer(async (baseUrl) => {
    const a = await postJson(baseUrl, '/api/v1/channel-users/upsert', { platform: 'feishu', external_id: 'same' });
    const b = await postJson(baseUrl, '/api/v1/channel-users/upsert', { platform: 'telegram', external_id: 'same' });
    const c = await postJson(baseUrl, '/api/v1/channel-users/upsert', { platform: 'feishu', external_id: 'Same' });
    const ab = (await a.json()) as { channel_user: { id: string } };
    const bb = (await b.json()) as { channel_user: { id: string } };
    const cb = (await c.json()) as { channel_user: { id: string } };
    assert.notEqual(bb.channel_user.id, ab.channel_user.id);
    assert.notEqual(cb.channel_user.id, ab.channel_user.id);
  });
});

test('HTTP group profile upsert repeats into same profile and returns snake_case DTOs', async () => {
  await withServer(async (baseUrl) => {
    const first = await postJson(baseUrl, '/api/v1/group-profiles', {
      platform: ' Feishu ',
      external_group_id: ' OC-1 ',
      display_name: '研发群',
      metadata: { source: 'chat' },
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      created: boolean;
      group_profile: {
        id: string;
        platform: string;
        external_group_id: string;
        normalized_external_group_id: string;
        display_name: string;
        group_type: string;
        tone: string;
        default_reply_mode: string;
        context_scope: string;
        memory_scope: string;
        metadata: Record<string, unknown>;
        retention: Record<string, string>;
        displayName?: string;
      };
    };
    assert.equal(firstBody.created, true);
    assert.equal(firstBody.group_profile.platform, 'feishu');
    assert.equal(firstBody.group_profile.external_group_id, 'OC-1');
    assert.equal(firstBody.group_profile.normalized_external_group_id, 'OC-1');
    assert.equal(firstBody.group_profile.display_name, '研发群');
    assert.equal(firstBody.group_profile.displayName, undefined);
    assert.equal(firstBody.group_profile.group_type, 'general');
    assert.equal(firstBody.group_profile.tone, 'neutral');
    assert.equal(firstBody.group_profile.default_reply_mode, 'thread');
    assert.equal(firstBody.group_profile.context_scope, 'group');
    assert.equal(firstBody.group_profile.memory_scope, 'group');
    assert.equal(firstBody.group_profile.retention.retention_class, 'operational');

    const replay = await postJson(baseUrl, '/api/v1/group-profiles', {
      platform: 'feishu',
      external_group_id: 'OC-1',
      display_name: '研发群 updated',
      group_type: 'team',
      tone: 'formal',
      default_reply_mode: 'dialog',
      context_scope: 'group.ops',
      memory_scope: 'group.ops',
      metadata: { source: 'updated' },
    });
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as typeof firstBody;
    assert.equal(replayBody.created, false);
    assert.equal(replayBody.group_profile.id, firstBody.group_profile.id);
    assert.equal(replayBody.group_profile.display_name, '研发群 updated');
    assert.equal(replayBody.group_profile.group_type, 'team');
    assert.equal(replayBody.group_profile.default_reply_mode, 'dialog');
    assert.equal(replayBody.group_profile.context_scope, 'group.ops');
    assert.deepEqual(replayBody.group_profile.metadata, { source: 'updated' });
  });
});

test('HTTP group profile get, resolve, defaults patch, and validation behavior', async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(baseUrl, '/api/v1/group-profiles', {
      platform: 'telegram',
      external_group_id: 'Group-1',
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { group_profile: { id: string } };

    const got = await fetch(`${baseUrl}/api/v1/group-profiles/${body.group_profile.id}`);
    assert.equal(got.status, 200);
    assert.equal(((await got.json()) as { group_profile: { id: string } }).group_profile.id, body.group_profile.id);

    const resolved = await fetch(`${baseUrl}/api/v1/group-profiles/resolve?platform=Telegram&external_group_id=Group-1`);
    assert.equal(resolved.status, 200);
    const resolvedBody = (await resolved.json()) as { group_profile: { id: string; platform: string } };
    assert.equal(resolvedBody.group_profile.id, body.group_profile.id);
    assert.equal(resolvedBody.group_profile.platform, 'telegram');

    const patched = await patchJson(baseUrl, `/api/v1/group-profiles/${body.group_profile.id}/defaults`, {
      default_reply_mode: 'dialog',
      context_scope: 'group.support',
      memory_scope: 'group.support',
      tone: 'friendly',
    });
    assert.equal(patched.status, 200);
    const patchedBody = (await patched.json()) as { group_profile: { default_reply_mode: string; context_scope: string; memory_scope: string; tone: string } };
    assert.equal(patchedBody.group_profile.default_reply_mode, 'dialog');
    assert.equal(patchedBody.group_profile.context_scope, 'group.support');
    assert.equal(patchedBody.group_profile.memory_scope, 'group.support');
    assert.equal(patchedBody.group_profile.tone, 'friendly');

    const invalidPatch = await patchJson(baseUrl, `/api/v1/group-profiles/${body.group_profile.id}/defaults`, { default_reply_mode: 'stream' });
    assert.equal(invalidPatch.status, 400);
    assert.equal(((await invalidPatch.json()) as { error: { code: string } }).error.code, 'AL_BAD_REQUEST');

    const missingPatch = await patchJson(baseUrl, '/api/v1/group-profiles/missing/defaults', { default_reply_mode: 'thread' });
    assert.equal(missingPatch.status, 404);
    assert.equal(((await missingPatch.json()) as { error: { code: string } }).error.code, 'AL_GROUP_PROFILE_NOT_FOUND');

    const missingGet = await fetch(`${baseUrl}/api/v1/group-profiles/missing`);
    assert.equal(missingGet.status, 404);
    assert.equal(((await missingGet.json()) as { error: { code: string } }).error.code, 'AL_GROUP_PROFILE_NOT_FOUND');

    const notFoundResolve = await fetch(`${baseUrl}/api/v1/group-profiles/resolve?platform=telegram&external_group_id=missing`);
    assert.equal(notFoundResolve.status, 404);
    assert.equal(((await notFoundResolve.json()) as { error: { code: string } }).error.code, 'AL_GROUP_PROFILE_NOT_FOUND');

    const badQuery = await fetch(`${baseUrl}/api/v1/group-profiles/resolve?platform=telegram`);
    assert.equal(badQuery.status, 400);
    assert.equal(((await badQuery.json()) as { error: { code: string } }).error.code, 'AL_BAD_REQUEST');
  });
});

test('HTTP group profile upsert does not merge different platform or external_group_id', async () => {
  await withServer(async (baseUrl) => {
    const a = await postJson(baseUrl, '/api/v1/group-profiles', { platform: 'feishu', external_group_id: 'same' });
    const b = await postJson(baseUrl, '/api/v1/group-profiles', { platform: 'telegram', external_group_id: 'same' });
    const c = await postJson(baseUrl, '/api/v1/group-profiles', { platform: 'feishu', external_group_id: 'Same' });
    const ab = (await a.json()) as { group_profile: { id: string } };
    const bb = (await b.json()) as { group_profile: { id: string } };
    const cb = (await c.json()) as { group_profile: { id: string } };
    assert.notEqual(bb.group_profile.id, ab.group_profile.id);
    assert.notEqual(cb.group_profile.id, ab.group_profile.id);

    const invalid = await postJson(baseUrl, '/api/v1/group-profiles', { platform: 'feishu', external_group_id: '', default_reply_mode: 'thread' });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, 'AL_BAD_REQUEST');
  });
});

test('HTTP ingress event creates/replays SourceEvent and exposes source-event/entry reads', async () => {
  await withServer(async (baseUrl) => {
    const channel = await postJson(baseUrl, '/api/v1/channel-users/upsert', { platform: 'feishu', external_id: 'ou_1' });
    const channelBody = (await channel.json()) as { channel_user: { id: string } };
    const group = await postJson(baseUrl, '/api/v1/group-profiles', { platform: 'feishu', external_group_id: 'oc_1' });
    const groupBody = (await group.json()) as { group_profile: { id: string } };

    const first = await postJson(baseUrl, '/api/v1/ingress/events', {
      source_system: ' Feishu ',
      source_ref: ' msg-1 ',
      event_type: 'message.receive',
      platform: 'Feishu',
      occurred_at: '2026-06-15T00:00:00.000Z',
      payload: { raw: true },
      metadata: { trace: 't1' },
      entry_type: 'group',
      external_chat_id: 'oc_1',
      external_thread_id: 'thread_1',
      external_message_id: 'msg_1',
      speaker_channel_user_id: channelBody.channel_user.id,
      group_profile_id: groupBody.group_profile.id,
      agent_mentioned: true,
      body_text: 'hello',
      entry_metadata: { parsed: true },
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      created: boolean;
      source_event: { id: string; source_system: string; source_ref: string; source_hash: string; retention: Record<string, string>; sourceSystem?: string };
      entry: { id: string; source_event_id: string; entry_type: string; body_text: string; speaker_channel_user_id: string; group_profile_id: string; sourceEventId?: string };
    };
    assert.equal(firstBody.created, true);
    assert.equal(firstBody.source_event.source_system, 'feishu');
    assert.equal(firstBody.source_event.source_ref, 'msg-1');
    assert.match(firstBody.source_event.source_hash, /^hmac-sha256:v1:[0-9a-f]{64}$/);
    assert.equal(firstBody.source_event.retention.retention_class, 'short_term');
    assert.equal(firstBody.source_event.retention.source_system, 'feishu');
    assert.equal(firstBody.source_event.sourceSystem, undefined);
    assert.equal(firstBody.entry.source_event_id, firstBody.source_event.id);
    assert.equal(firstBody.entry.entry_type, 'group');
    assert.equal(firstBody.entry.speaker_channel_user_id, channelBody.channel_user.id);
    assert.equal(firstBody.entry.group_profile_id, groupBody.group_profile.id);
    assert.equal(firstBody.entry.sourceEventId, undefined);

    const replay = await postJson(baseUrl, '/api/v1/ingress/events', { source_system: 'feishu', source_ref: 'msg-1', event_type: 'message.receive', body_text: 'ignored' });
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as typeof firstBody;
    assert.equal(replayBody.created, false);
    assert.equal(replayBody.source_event.id, firstBody.source_event.id);
    assert.equal(replayBody.entry.id, firstBody.entry.id);

    const resolved = await fetch(`${baseUrl}/api/v1/source-events/resolve?source_system=Feishu&source_ref=msg-1`);
    assert.equal(resolved.status, 200);
    assert.equal(((await resolved.json()) as { source_event: { id: string } }).source_event.id, firstBody.source_event.id);

    const gotEvent = await fetch(`${baseUrl}/api/v1/source-events/${firstBody.source_event.id}`);
    assert.equal(gotEvent.status, 200);
    const gotEntry = await fetch(`${baseUrl}/api/v1/entries/${firstBody.entry.id}`);
    assert.equal(gotEntry.status, 200);
    const gotEntryByEvent = await fetch(`${baseUrl}/api/v1/source-events/${firstBody.source_event.id}/entry`);
    assert.equal(gotEntryByEvent.status, 200);
  });
});

test('HTTP ingress event covers validation and optional reference 404s', async () => {
  await withServer(async (baseUrl) => {
    const bad = await postJson(baseUrl, '/api/v1/ingress/events', { source_system: 'bad source', source_ref: 'msg', event_type: 'message' });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'AL_BAD_REQUEST');

    const missingUser = await postJson(baseUrl, '/api/v1/ingress/events', {
      source_system: 'feishu',
      source_ref: 'missing-user',
      event_type: 'message',
      speaker_channel_user_id: '00000000-0000-4000-8000-000000000404',
    });
    assert.equal(missingUser.status, 404);
    assert.equal(((await missingUser.json()) as { error: { code: string } }).error.code, 'AL_CHANNEL_USER_NOT_FOUND');

    const missingGroup = await postJson(baseUrl, '/api/v1/ingress/events', {
      source_system: 'feishu',
      source_ref: 'missing-group',
      event_type: 'message',
      group_profile_id: '00000000-0000-4000-8000-000000000405',
    });
    assert.equal(missingGroup.status, 404);
    assert.equal(((await missingGroup.json()) as { error: { code: string } }).error.code, 'AL_GROUP_PROFILE_NOT_FOUND');

    const missingEvent = await fetch(`${baseUrl}/api/v1/source-events/00000000-0000-4000-8000-000000000404`);
    assert.equal(missingEvent.status, 404);
    assert.equal(((await missingEvent.json()) as { error: { code: string } }).error.code, 'AL_SOURCE_EVENT_NOT_FOUND');
    const missingEntry = await fetch(`${baseUrl}/api/v1/entries/00000000-0000-4000-8000-000000000404`);
    assert.equal(missingEntry.status, 404);
    assert.equal(((await missingEntry.json()) as { error: { code: string } }).error.code, 'AL_ENTRY_NOT_FOUND');
  });
});


test('HTTP ingress endpoints require configured bearer token and allow valid token', async () => {
  const auth = { authorization: 'Bearer ingress-test-token' };
  await withServer(async (baseUrl) => {
    const payload = { source_system: 'feishu', source_ref: 'auth-msg-1', event_type: 'message.receive', body_text: 'hello' };

    const missingToken = await postJson(baseUrl, '/api/v1/ingress/events', payload);
    assert.equal(missingToken.status, 401);
    assert.equal(((await missingToken.json()) as { error: { code: string } }).error.code, 'AL_AUTH_REQUIRED');

    const wrongToken = await postJson(baseUrl, '/api/v1/ingress/events', payload, { authorization: 'Bearer wrong' });
    assert.equal(wrongToken.status, 403);
    assert.equal(((await wrongToken.json()) as { error: { code: string } }).error.code, 'AL_FORBIDDEN');

    const created = await postJson(baseUrl, '/api/v1/ingress/events', payload, auth);
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { source_event: { id: string }; entry: { id: string } };

    const resolveMissingToken = await fetch(`${baseUrl}/api/v1/source-events/resolve?source_system=feishu&source_ref=auth-msg-1`);
    assert.equal(resolveMissingToken.status, 401);

    const resolved = await fetch(`${baseUrl}/api/v1/source-events/resolve?source_system=feishu&source_ref=auth-msg-1`, { headers: auth });
    assert.equal(resolved.status, 200);
    assert.equal(((await resolved.json()) as { source_event: { id: string } }).source_event.id, createdBody.source_event.id);

    const gotEvent = await fetch(`${baseUrl}/api/v1/source-events/${createdBody.source_event.id}`, { headers: auth });
    assert.equal(gotEvent.status, 200);
    const gotEntryByEvent = await fetch(`${baseUrl}/api/v1/source-events/${createdBody.source_event.id}/entry`, { headers: auth });
    assert.equal(gotEntryByEvent.status, 200);
    const gotEntry = await fetch(`${baseUrl}/api/v1/entries/${createdBody.entry.id}`, { headers: auth });
    assert.equal(gotEntry.status, 200);
  }, { ingressBearerToken: 'ingress-test-token' });
});

test('HTTP fake IM endpoint requires ingress bearer and maps dm/group/thread events to SourceEvent/Entry', async () => {
  const auth = { authorization: 'Bearer fake-im-token' };
  await withServer(async (baseUrl) => {
    const dmPayload = { kind: 'dm', message_id: 'dm-msg-1', text: 'hello dm', agent_mentioned: true };
    const missingToken = await postJson(baseUrl, '/api/v1/fake-im/events', dmPayload);
    assert.equal(missingToken.status, 401);
    assert.equal(((await missingToken.json()) as { error: { code: string } }).error.code, 'AL_AUTH_REQUIRED');

    const wrongToken = await postJson(baseUrl, '/api/v1/fake-im/events', dmPayload, { authorization: 'Bearer wrong' });
    assert.equal(wrongToken.status, 403);
    assert.equal(((await wrongToken.json()) as { error: { code: string } }).error.code, 'AL_FORBIDDEN');

    const dm = await postJson(baseUrl, '/api/v1/fake-im/events', dmPayload, auth);
    assert.equal(dm.status, 201);
    const dmBody = (await dm.json()) as {
      created: boolean;
      fake_im_event: { kind: string; message_id: string; source_ref: string };
      source_event: { id: string; source_system: string; source_ref: string; payload: { fake_im_event: { message_id: string } } };
      entry: { id: string; source_event_id: string; entry_type: string; body_text: string; agent_mentioned: boolean; external_message_id: string };
    };
    assert.equal(dmBody.created, true);
    assert.equal(dmBody.fake_im_event.source_ref, 'fake-im:dm:dm:none:dm-msg-1');
    assert.equal(dmBody.source_event.source_system, 'fake-im');
    assert.equal(dmBody.source_event.source_ref, 'fake-im:dm:dm:none:dm-msg-1');
    assert.equal(dmBody.source_event.payload.fake_im_event.message_id, 'dm-msg-1');
    assert.equal(dmBody.entry.entry_type, 'dm');
    assert.equal(dmBody.entry.body_text, 'hello dm');
    assert.equal(dmBody.entry.agent_mentioned, true);
    assert.equal(dmBody.entry.external_message_id, 'dm-msg-1');

    const replay = await postJson(baseUrl, '/api/v1/fake-im/events', { ...dmPayload, text: 'ignored replay text' }, auth);
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as typeof dmBody;
    assert.equal(replayBody.created, false);
    assert.equal(replayBody.source_event.id, dmBody.source_event.id);
    assert.equal(replayBody.entry.id, dmBody.entry.id);
    assert.equal(replayBody.entry.body_text, 'hello dm');

    const channel = await postJson(baseUrl, '/api/v1/channel-users/upsert', { platform: 'fake-im', external_id: 'speaker-1' });
    const channelBody = (await channel.json()) as { channel_user: { id: string } };
    const group = await postJson(baseUrl, '/api/v1/group-profiles', { platform: 'fake-im', external_group_id: 'oc_1' });
    const groupBody = (await group.json()) as { group_profile: { id: string } };

    const groupEvent = await postJson(baseUrl, '/api/v1/fake-im/events', {
      kind: 'group',
      message_id: 'group-msg-1',
      chat_id: 'oc_1',
      text: 'hello group',
      speaker_channel_user_id: channelBody.channel_user.id,
      group_profile_id: groupBody.group_profile.id,
      metadata: { trace: 'group' },
    }, auth);
    assert.equal(groupEvent.status, 201);
    const groupEventBody = (await groupEvent.json()) as { source_event: { source_ref: string; metadata: { trace: string } }; entry: { entry_type: string; external_chat_id: string; speaker_channel_user_id: string; group_profile_id: string } };
    assert.equal(groupEventBody.source_event.source_ref, 'fake-im:group:oc_1:none:group-msg-1');
    assert.equal(groupEventBody.source_event.metadata.trace, 'group');
    assert.equal(groupEventBody.entry.entry_type, 'group');
    assert.equal(groupEventBody.entry.external_chat_id, 'oc_1');
    assert.equal(groupEventBody.entry.speaker_channel_user_id, channelBody.channel_user.id);
    assert.equal(groupEventBody.entry.group_profile_id, groupBody.group_profile.id);

    const threadReply = await postJson(baseUrl, '/api/v1/fake-im/events', {
      kind: 'thread',
      message_id: 'thread-msg-1',
      chat_id: 'oc_1',
      thread_id: 'thread_1',
      reply_to_message_id: 'group-msg-1',
      text: 'thread reply',
      occurred_at: '2026-06-15T01:02:03.000Z',
    }, auth);
    assert.equal(threadReply.status, 201);
    const threadReplyBody = (await threadReply.json()) as {
      fake_im_event: { reply_to_message_id: string; occurred_at: string };
      source_event: { id: string; source_ref: string; payload: { fake_im_event: { reply_to_message_id: string } } };
      entry: { id: string; entry_type: string; external_chat_id: string; external_thread_id: string; body_text: string };
    };
    assert.equal(threadReplyBody.fake_im_event.reply_to_message_id, 'group-msg-1');
    assert.equal(threadReplyBody.fake_im_event.occurred_at, '2026-06-15T01:02:03.000Z');
    assert.equal(threadReplyBody.source_event.source_ref, 'fake-im:thread:oc_1:thread_1:thread-msg-1');
    assert.equal(threadReplyBody.source_event.payload.fake_im_event.reply_to_message_id, 'group-msg-1');
    assert.equal(threadReplyBody.entry.entry_type, 'thread');
    assert.equal(threadReplyBody.entry.external_chat_id, 'oc_1');
    assert.equal(threadReplyBody.entry.external_thread_id, 'thread_1');
    assert.equal(threadReplyBody.entry.body_text, 'thread reply');

    const resolved = await fetch(`${baseUrl}/api/v1/source-events/resolve?source_system=fake-im&source_ref=${encodeURIComponent('fake-im:thread:oc_1:thread_1:thread-msg-1')}`, { headers: auth });
    assert.equal(resolved.status, 200);
    assert.equal(((await resolved.json()) as { source_event: { id: string } }).source_event.id, threadReplyBody.source_event.id);
    const gotEntry = await fetch(`${baseUrl}/api/v1/source-events/${threadReplyBody.source_event.id}/entry`, { headers: auth });
    assert.equal(gotEntry.status, 200);
    assert.equal(((await gotEntry.json()) as { entry: { id: string } }).entry.id, threadReplyBody.entry.id);
  }, { ingressBearerToken: 'fake-im-token' });
});

test('HTTP fake IM endpoint rejects invalid input and missing optional references', async () => {
  const auth = { authorization: 'Bearer fake-im-token' };
  await withServer(async (baseUrl) => {
    const invalid = await postJson(baseUrl, '/api/v1/fake-im/events', { kind: 'thread', message_id: 'msg', chat_id: 'oc', text: 'missing thread' }, auth);
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, 'AL_BAD_REQUEST');

    const missingUser = await postJson(baseUrl, '/api/v1/fake-im/events', {
      kind: 'dm',
      message_id: 'missing-user',
      text: 'hello',
      speaker_channel_user_id: '00000000-0000-4000-8000-000000000404',
    }, auth);
    assert.equal(missingUser.status, 404);
    assert.equal(((await missingUser.json()) as { error: { code: string } }).error.code, 'AL_CHANNEL_USER_NOT_FOUND');

    const missingGroup = await postJson(baseUrl, '/api/v1/fake-im/events', {
      kind: 'group',
      message_id: 'missing-group',
      chat_id: 'oc_missing',
      text: 'hello',
      group_profile_id: '00000000-0000-4000-8000-000000000405',
    }, auth);
    assert.equal(missingGroup.status, 404);
    assert.equal(((await missingGroup.json()) as { error: { code: string } }).error.code, 'AL_GROUP_PROFILE_NOT_FOUND');
  }, { ingressBearerToken: 'fake-im-token' });
});
