import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WORKSPACE, InMemoryControlPlane } from '../src/control-plane/in-memory.js';
import { AgentlinkError } from '../src/control-plane/errors.js';


function bootstrap() {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-11T00:00:00.000Z') });
  const registered = controlPlane.registerDevice({
    displayName: 'claw-tenc',
    ownerUserId: 'whiteParachute',
    capabilityGrants: ['codex:exec'],
    workdirGrants: [{ pathPrefix: DEFAULT_WORKSPACE, accessMode: 'read_write' }],
  });
  controlPlane.heartbeat(registered.device.id, registered.deviceSecret);
  const created = controlPlane.createTask(
    { source: 'telegram', sourceRef: 'telegram:chat:msg', payload: { text: 'hello codex' } },
    'idem-task-1',
  );
  return { controlPlane, registered, created };
}

test('createTask is idempotent and rejects conflicting reuse', () => {
  const controlPlane = new InMemoryControlPlane();
  const first = controlPlane.createTask({ source: 'telegram', sourceRef: 'telegram:1', payload: { text: 'a' } }, 'same-key');
  const replay = controlPlane.createTask({ source: 'telegram', sourceRef: 'telegram:1', payload: { text: 'a' } }, 'same-key');
  assert.equal(replay.created, false);
  assert.equal(replay.task.id, first.task.id);
  assert.throws(
    () => controlPlane.createTask({ source: 'telegram', sourceRef: 'telegram:1', payload: { text: 'b' } }, 'same-key'),
    (error) => error instanceof AgentlinkError && error.code === 'AL_IDEMPOTENCY_CONFLICT',
  );
});

test('agentlet pull issues only one active lease for a queued run', () => {
  const { controlPlane, registered, created } = bootstrap();
  const first = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(first);
  assert.equal(first.runId, created.run.id);
  assert.equal(controlPlane.getRun(created.run.id)?.status, 'LEASED');
  assert.equal(typeof controlPlane.getRun(created.run.id)?.policyDecisionId, 'string');
  assert.equal(controlPlane.getPolicyDecisions(created.run.id).at(-1)?.decision, 'ALLOW');

  const second = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.equal(second, undefined);
});

test('policy evaluation denies missing capability and workdir grants before leasing', () => {
  const noCapabilityGrant = new InMemoryControlPlane({ now: () => new Date('2026-06-11T00:00:00.000Z') });
  const registeredWithoutCapability = noCapabilityGrant.registerDevice({
    displayName: 'claw-tenc',
    ownerUserId: 'whiteParachute',
    workdirGrants: [{ pathPrefix: DEFAULT_WORKSPACE, accessMode: 'read_write' }],
  });
  noCapabilityGrant.heartbeat(registeredWithoutCapability.device.id, registeredWithoutCapability.deviceSecret);
  const capabilityDeniedTask = noCapabilityGrant.createTask(
    { source: 'telegram', sourceRef: 'telegram:policy:capability', payload: { text: 'hello codex' } },
    'idem-policy-capability',
  );
  assert.throws(
    () => noCapabilityGrant.pull({ deviceId: registeredWithoutCapability.device.id, runnerId: registeredWithoutCapability.runner.id }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_CAPABILITY_DENIED',
  );
  assert.equal(noCapabilityGrant.getPolicyDecisions(capabilityDeniedTask.run.id).at(-1)?.decision, 'DENY');

  const noWorkdirGrant = new InMemoryControlPlane({ now: () => new Date('2026-06-11T00:00:00.000Z') });
  const registeredWithoutWorkdir = noWorkdirGrant.registerDevice({
    displayName: 'claw-tenc',
    ownerUserId: 'whiteParachute',
    capabilityGrants: ['codex:exec'],
  });
  noWorkdirGrant.heartbeat(registeredWithoutWorkdir.device.id, registeredWithoutWorkdir.deviceSecret);
  const workdirDeniedTask = noWorkdirGrant.createTask(
    { source: 'telegram', sourceRef: 'telegram:policy:workdir', payload: { text: 'hello codex' } },
    'idem-policy-workdir',
  );
  assert.throws(
    () => noWorkdirGrant.pull({ deviceId: registeredWithoutWorkdir.device.id, runnerId: registeredWithoutWorkdir.runner.id }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_WORKDIR_DENIED',
  );
  assert.equal(noWorkdirGrant.getPolicyDecisions(workdirDeniedTask.run.id).at(-1)?.reason?.includes('workdir grants'), true);
});

test('grant management can add and revoke capability and workdir grants', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-11T00:00:00.000Z') });
  const registered = controlPlane.registerDevice({ displayName: 'claw-tenc', ownerUserId: 'whiteParachute' });
  controlPlane.heartbeat(registered.device.id, registered.deviceSecret);
  controlPlane.createTask(
    { source: 'telegram', sourceRef: 'telegram:grant-management', payload: { text: 'grant me' } },
    'idem-grant-management',
  );

  assert.throws(
    () => controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_CAPABILITY_DENIED',
  );

  const capabilityGrant = controlPlane.grantCapability({
    deviceId: registered.device.id,
    runnerId: registered.runner.id,
    capability: 'codex:exec',
    grantedBy: 'test',
  });
  assert.equal(capabilityGrant.grantStatus, 'GRANTED');
  assert.deepEqual(controlPlane.listCapabilityGrants(registered.device.id).map((grant) => grant.id), [capabilityGrant.id]);

  assert.throws(
    () => controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_WORKDIR_DENIED',
  );

  const workdirGrant = controlPlane.grantWorkdir({ deviceId: registered.device.id, pathPrefix: DEFAULT_WORKSPACE, accessMode: 'read_write' });
  assert.equal(workdirGrant.accessMode, 'read_write');
  assert.deepEqual(controlPlane.listWorkdirGrants(registered.device.id).map((grant) => grant.id), [workdirGrant.id]);

  assert.ok(controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id }));

  assert.equal(controlPlane.revokeCapabilityGrant(capabilityGrant.id).grantStatus, 'REVOKED');
  assert.equal(typeof controlPlane.revokeWorkdirGrant(workdirGrant.id).revokedAt, 'string');

  controlPlane.createTask(
    { source: 'telegram', sourceRef: 'telegram:grant-management-after-revoke', payload: { text: 'should deny' } },
    'idem-grant-management-after-revoke',
  );
  assert.throws(
    () => controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_CAPABILITY_DENIED',
  );
});

test('policy evaluation denies network_scope mismatches', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-11T00:00:00.000Z') });
  const registered = controlPlane.registerDevice({
    displayName: 'claw-tenc',
    ownerUserId: 'whiteParachute',
    networkScope: 'personal',
    capabilityGrants: ['codex:exec'],
    workdirGrants: [{ pathPrefix: DEFAULT_WORKSPACE, accessMode: 'read_write' }],
  });
  controlPlane.heartbeat(registered.device.id, registered.deviceSecret);
  const created = controlPlane.createTask(
    {
      source: 'telegram',
      sourceRef: 'telegram:policy:network',
      payload: { text: 'hello codex' },
      taskSpec: { network_scope: 'work' },
    },
    'idem-policy-network',
  );

  assert.throws(
    () => controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_POLICY_DENIED',
  );
  assert.equal(controlPlane.getPolicyDecisions(created.run.id).at(-1)?.reason?.includes('network_scope'), true);
});



test('progress and complete require an acknowledged running lease', () => {
  const { controlPlane, registered } = bootstrap();
  const instruction = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(instruction);

  assert.throws(
    () => controlPlane.appendProgress({ runId: instruction.runId, leaseId: instruction.leaseId, seq: 1, eventType: 'STDOUT' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_STATE_CONFLICT',
  );
  assert.throws(
    () => controlPlane.completeRun({ runId: instruction.runId, leaseId: instruction.leaseId, status: 'SUCCEEDED' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_STATE_CONFLICT',
  );

  controlPlane.ackLease(instruction.leaseId, true);
  assert.equal(controlPlane.appendProgress({ runId: instruction.runId, leaseId: instruction.leaseId, seq: 1, eventType: 'STDOUT' }).eventType, 'STDOUT');
});


test('ack/progress/complete advances Task Run Lease and rejects late progress', () => {
  const { controlPlane, registered } = bootstrap();
  const instruction = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(instruction);

  const acked = controlPlane.ackLease(instruction.leaseId, true);
  assert.equal(acked.lease.status, 'ACKED');
  assert.equal(acked.run.status, 'RUNNING');
  assert.equal(acked.task.status, 'RUNNING');

  const progress = controlPlane.appendProgress({
    runId: instruction.runId,
    leaseId: instruction.leaseId,
    seq: 1,
    eventType: 'STDOUT',
    payload: { text: 'working' },
  });
  assert.equal(progress.seq, 1);
  assert.equal(
    controlPlane.appendProgress({ runId: instruction.runId, leaseId: instruction.leaseId, seq: 1, eventType: 'STDOUT', payload: { text: 'working' } }),
    progress,
  );
  assert.throws(
    () => controlPlane.appendProgress({ runId: instruction.runId, leaseId: instruction.leaseId, seq: 1, eventType: 'STDOUT', payload: { text: 'different' } }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_IDEMPOTENCY_CONFLICT',
  );

  const completed = controlPlane.completeRun({
    runId: instruction.runId,
    leaseId: instruction.leaseId,
    status: 'SUCCEEDED',
    result: { text: 'done' },
  });
  assert.equal(completed.lease.status, 'COMPLETED');
  assert.equal(completed.run.status, 'SUCCEEDED');
  assert.equal(completed.task.status, 'SUCCEEDED');

  assert.throws(
    () => controlPlane.appendProgress({ runId: instruction.runId, leaseId: instruction.leaseId, seq: 2, eventType: 'STDOUT' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_LEASE_EXPIRED',
  );
});


test('retryable failed completion creates a new queued run attempt', () => {
  const { controlPlane, registered, created } = bootstrap();
  const instruction = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(instruction);
  controlPlane.ackLease(instruction.leaseId, true);

  const failed = controlPlane.completeRun({
    runId: instruction.runId,
    leaseId: instruction.leaseId,
    status: 'FAILED',
    error: { retryable: true, message: 'transient runner failure' },
  });

  assert.equal(failed.run.status, 'FAILED');
  assert.equal(failed.task.status, 'QUEUED');
  assert.equal(failed.task.retryCount, 1);
  assert.notEqual(failed.task.currentRunId, created.run.id);

  const nextRun = controlPlane.getRun(failed.task.currentRunId);
  assert.ok(nextRun);
  assert.equal(nextRun.status, 'QUEUED');
  assert.equal(nextRun.attemptNo, 2);
  assert.equal(nextRun.retryOfRunId, created.run.id);

  const replay = controlPlane.completeRun({
    runId: instruction.runId,
    leaseId: instruction.leaseId,
    status: 'FAILED',
    error: { retryable: true, message: 'transient runner failure' },
  });
  assert.equal(replay.task.currentRunId, failed.task.currentRunId);

  assert.throws(
    () => controlPlane.completeRun({ runId: instruction.runId, leaseId: instruction.leaseId, status: 'FAILED', error: { retryable: true, message: 'different' } }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_LEASE_EXPIRED',
  );
});



test('terminal complete replay is scoped to the same run and lease', () => {
  const { controlPlane, registered } = bootstrap();

  const first = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(first);
  controlPlane.ackLease(first.leaseId, true);
  controlPlane.completeRun({ runId: first.runId, leaseId: first.leaseId, status: 'SUCCEEDED', result: { text: 'same' } });

  const secondCreated = controlPlane.createTask(
    { source: 'telegram', sourceRef: 'telegram:chat:second', payload: { text: 'same payload' } },
    'idem-task-2',
  );
  const second = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(second);
  controlPlane.ackLease(second.leaseId, true);
  controlPlane.completeRun({ runId: second.runId, leaseId: second.leaseId, status: 'SUCCEEDED', result: { text: 'same' } });

  assert.throws(
    () => controlPlane.completeRun({ runId: secondCreated.run.id, leaseId: first.leaseId, status: 'SUCCEEDED', result: { text: 'same' } }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_LEASE_EXPIRED',
  );
});
test('ack reject returns the run to QUEUED and permits a later lease', () => {
  const { controlPlane, registered, created } = bootstrap();
  const first = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(first);
  const rejected = controlPlane.ackLease(first.leaseId, false, 'busy');
  assert.equal(rejected.lease.status, 'REJECTED');
  assert.equal(rejected.run.status, 'QUEUED');
  assert.equal(rejected.task.status, 'QUEUED');
  assert.equal(controlPlane.getRun(created.run.id)?.currentLeaseId, undefined);

  const second = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(second);
  assert.notEqual(second.leaseId, first.leaseId);
});

test('task cancel emits a cancel_run control action and removes it from recovery', () => {
  const { controlPlane, registered, created } = bootstrap();
  const instruction = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(instruction);
  controlPlane.ackLease(instruction.leaseId, true);

  const beforeCancelRecovery = controlPlane.recoverDevice(registered.device.id);
  assert.equal(beforeCancelRecovery.recoverableRuns.length, 1);
  assert.equal(beforeCancelRecovery.recoverableRuns[0]?.runId, instruction.runId);

  const cancelled = controlPlane.cancelTask(created.task.id, 'user_cancelled');
  assert.equal(cancelled.task.status, 'CANCELLED');
  assert.equal(cancelled.run?.status, 'CANCELLED');
  assert.equal(cancelled.lease?.status, 'CANCELLED');
  assert.equal(cancelled.controlActions.length, 1);
  assert.equal(cancelled.controlActions[0]?.type, 'cancel_run');
  assert.equal(cancelled.controlActions[0]?.runId, instruction.runId);
  assert.equal(cancelled.controlActions[0]?.leaseId, instruction.leaseId);
  assert.equal(cancelled.controlActions[0]?.reason, 'user_cancelled');
  assert.equal(cancelled.controlActions[0]?.status, 'PENDING');

  const polled = controlPlane.pollControl(registered.device.id);
  assert.deepEqual(polled.controlActions, cancelled.controlActions);
  const acked = controlPlane.ackControlAction(registered.device.id, cancelled.controlActions[0]?.id ?? '');
  assert.equal(acked.controlAction.status, 'ACKED');
  assert.deepEqual(controlPlane.pollControl(registered.device.id).controlActions, []);
  assert.deepEqual(controlPlane.recoverDevice(registered.device.id).recoverableRuns, []);
});

test('device revoke cancels active work and blocks future agentlet auth', () => {
  const { controlPlane, registered } = bootstrap();
  const instruction = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(instruction);
  controlPlane.ackLease(instruction.leaseId, true);

  const revoked = controlPlane.revokeDevice(registered.device.id, 'operator_revoked');
  assert.equal(revoked.device.status, 'REVOKED');
  assert.equal(typeof revoked.device.revokedAt, 'string');
  assert.equal(revoked.leases.length, 1);
  assert.equal(revoked.leases[0]?.status, 'CANCELLED');
  assert.equal(revoked.leases[0]?.expireReason, 'operator_revoked');
  assert.equal(revoked.runs[0]?.status, 'CANCELLED');
  assert.equal(revoked.tasks[0]?.status, 'CANCELLED');

  assert.throws(
    () => controlPlane.authenticateDevice(registered.device.id, registered.deviceSecret),
    (error) => error instanceof AgentlinkError && error.code === 'AL_TOKEN_REVOKED',
  );
  assert.deepEqual(controlPlane.recoverDevice(registered.device.id).recoverableRuns, []);
});

test('lease renew extends an executing lease and recovery decisions continue or discard active work', () => {
  const { controlPlane, registered } = bootstrap();
  const first = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(first);
  assert.throws(
    () => controlPlane.renewLease(first.leaseId),
    (error) => error instanceof AgentlinkError && error.code === 'AL_STATE_CONFLICT',
  );
  assert.throws(
    () => controlPlane.decideRecovery({ deviceId: registered.device.id, leaseId: first.leaseId, decision: 'continue' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_STATE_CONFLICT',
  );
  controlPlane.ackLease(first.leaseId, true);

  const renewed = controlPlane.renewLease(first.leaseId);
  assert.equal(renewed.lease.status, 'RENEWED');
  assert.equal(renewed.run.status, 'RUNNING');
  assert.equal(renewed.task.status, 'RUNNING');
  assert.deepEqual(renewed.controlActions, []);

  const continued = controlPlane.decideRecovery({ deviceId: registered.device.id, leaseId: first.leaseId, decision: 'continue' });
  assert.equal(continued.decision, 'continue');
  assert.equal(continued.lease.status, 'RENEWED');
  assert.equal(continued.run.status, 'RUNNING');

  const secondCreated = controlPlane.createTask(
    { source: 'telegram', sourceRef: 'telegram:chat:recover-discard', payload: { text: 'discard me' } },
    'idem-recover-discard',
  );
  const second = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(second);
  controlPlane.ackLease(second.leaseId, true);
  const discarded = controlPlane.decideRecovery({ deviceId: registered.device.id, leaseId: second.leaseId, decision: 'discard', reason: 'lost_process' });
  assert.equal(discarded.decision, 'discard');
  assert.equal(discarded.lease.status, 'EXPIRED');
  assert.equal(discarded.run.status, 'TIMED_OUT');
  assert.equal(discarded.task.status, 'QUEUED');
  assert.equal(discarded.task.retryCount, 1);
  assert.notEqual(discarded.task.currentRunId, secondCreated.run.id);
  assert.equal(discarded.retryRun?.attemptNo, 2);
});

test('task has default retention metadata when none is provided', () => {
  const { created } = bootstrap();
  assert.equal(created.task.retentionClass, 'operational');
  assert.equal(created.task.memorySpace, 'default');
  assert.equal(created.task.sourceSystem, 'agentlink');
  assert.equal(created.task.sensitivity, 'internal');
});

test('initial run inherits retention metadata from task', () => {
  const { created } = bootstrap();
  assert.equal(created.run.retentionClass, created.task.retentionClass);
  assert.equal(created.run.memorySpace, created.task.memorySpace);
  assert.equal(created.run.sourceSystem, created.task.sourceSystem);
  assert.equal(created.run.sensitivity, created.task.sensitivity);
});

test('createTask accepts explicit retention metadata', () => {
  const controlPlane = new InMemoryControlPlane();
  const created = controlPlane.createTask(
    {
      source: 'telegram',
      sourceRef: 'msg:1',
      payload: { text: 'hi' },
      retention: {
        retentionClass: 'memory_candidate',
        sensitivity: 'confidential',
        memorySpace: 'work.demo',
        sourceSystem: 'telegram',
      },
    },
    'idem-explicit-retention',
  );
  assert.equal(created.task.retentionClass, 'memory_candidate');
  assert.equal(created.task.sensitivity, 'confidential');
  assert.equal(created.task.memorySpace, 'work.demo');
  assert.equal(created.task.sourceSystem, 'telegram');
  assert.equal(created.run.retentionClass, 'memory_candidate');
});

test('appendProgress events have agentlet-default retention', () => {
  const { controlPlane, registered, created } = bootstrap();
  const pulled = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(pulled);
  controlPlane.ackLease(pulled.leaseId, true);
  const event = controlPlane.appendProgress({
    runId: created.run.id,
    leaseId: pulled.leaseId,
    seq: 1,
    eventType: 'STDOUT',
    payload: { text: 'hello' },
  });
  assert.equal(event.retentionClass, 'short_term');
  assert.equal(event.sourceSystem, 'agentlet');
  assert.equal(event.memorySpace, 'default');
  assert.equal(event.sensitivity, 'internal');
});

test('appendProgress accepts explicit retention override', () => {
  const { controlPlane, registered, created } = bootstrap();
  const pulled = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.ok(pulled);
  controlPlane.ackLease(pulled.leaseId, true);
  const event = controlPlane.appendProgress({
    runId: created.run.id,
    leaseId: pulled.leaseId,
    seq: 1,
    eventType: 'artifact',
    payload: { hash: 'abc' },
    retention: { retentionClass: 'artifact', sensitivity: 'public' },
  });
  assert.equal(event.retentionClass, 'artifact');
  assert.equal(event.sensitivity, 'public');
});

test('idempotency replay works when omitting retention vs passing explicit defaults', () => {
  const controlPlane = new InMemoryControlPlane();
  const first = controlPlane.createTask(
    { source: 'telegram', sourceRef: 'msg:1', payload: { text: 'hi' } },
    'replay-key',
  );
  const replay = controlPlane.createTask(
    {
      source: 'telegram',
      sourceRef: 'msg:1',
      payload: { text: 'hi' },
      retention: {
        retentionClass: 'operational',
        sensitivity: 'internal',
        memorySpace: 'default',
        sourceSystem: 'agentlink',
      },
    },
    'replay-key',
  );
  assert.equal(replay.created, false);
  assert.equal(replay.task.id, first.task.id);
});

test('idempotency conflict when retention differs from normalized defaults', () => {
  const controlPlane = new InMemoryControlPlane();
  controlPlane.createTask(
    { source: 'telegram', sourceRef: 'msg:1', payload: { text: 'hi' } },
    'conflict-key',
  );
  assert.throws(
    () =>
      controlPlane.createTask(
        {
          source: 'telegram',
          sourceRef: 'msg:1',
          payload: { text: 'hi' },
          retention: { memorySpace: 'other-space' },
        },
        'conflict-key',
      ),
    (error) => error instanceof AgentlinkError && error.code === 'AL_IDEMPOTENCY_CONFLICT',
  );
});

test('idempotency conflict when sensitivity changes', () => {
  const controlPlane = new InMemoryControlPlane();
  controlPlane.createTask(
    { source: 'telegram', sourceRef: 'msg:1', payload: { text: 'hi' } },
    'sens-key',
  );
  assert.throws(
    () =>
      controlPlane.createTask(
        {
          source: 'telegram',
          sourceRef: 'msg:1',
          payload: { text: 'hi' },
          retention: { sensitivity: 'secret' },
        },
        'sens-key',
      ),
    (error) => error instanceof AgentlinkError && error.code === 'AL_IDEMPOTENCY_CONFLICT',
  );
});

test('raw payload content can coexist with retention metadata (unique raw guard)', () => {
  const controlPlane = new InMemoryControlPlane();
  const rawPayload = { text: 'raw message content', user_id: 123 };
  const created = controlPlane.createTask(
    { source: 'telegram', sourceRef: 'msg:raw', payload: rawPayload },
    'raw-guard-key',
  );
  // Raw payload is preserved
  assert.deepEqual(created.task.payload, rawPayload);
  // But retention metadata is always present
  assert.ok(created.task.retentionClass);
  assert.ok(created.task.memorySpace);
  assert.ok(created.task.sourceSystem);
  assert.ok(created.task.sensitivity);
  assert.equal(created.task.retentionClass, 'operational');
  assert.ok(created.run.retentionClass);
});

test('main user profile starts undefined', () => {
  const controlPlane = new InMemoryControlPlane();
  assert.equal(controlPlane.getMainUserProfile(), undefined);
});

test('main user profile creates on first upsert and returns created=true', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-12T00:00:00.000Z') });
  const result = controlPlane.upsertMainUserProfile({ displayName: 'Alice' });
  assert.equal(result.created, true);
  assert.equal(result.mainUser.id, 'main');
  assert.equal(result.mainUser.displayName, 'Alice');
  assert.equal(result.mainUser.locale, 'zh-CN');
  assert.equal(result.mainUser.timezone, 'Asia/Shanghai');
  assert.equal(result.mainUser.retentionClass, 'operational');
  assert.equal(result.mainUser.memorySpace, 'default');
  assert.equal(result.mainUser.sourceSystem, 'agentlink');
  assert.equal(result.mainUser.sensitivity, 'internal');
  assert.equal(result.mainUser.createdAt, '2026-06-12T00:00:00.000Z');
  assert.equal(result.mainUser.updatedAt, '2026-06-12T00:00:00.000Z');
});

test('main user profile update returns created=false and preserves createdAt', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-12T00:00:00.000Z') });
  const first = controlPlane.upsertMainUserProfile({ displayName: 'Alice' });
  const second = controlPlane.upsertMainUserProfile({ displayName: 'Alice Updated', locale: 'zh-CN' });
  assert.equal(second.created, false);
  assert.equal(second.mainUser.displayName, 'Alice Updated');
  assert.equal(second.mainUser.locale, 'zh-CN');
  assert.equal(second.mainUser.createdAt, first.mainUser.createdAt);
});

test('main user profile upsert preserves unspecified fields', () => {
  const controlPlane = new InMemoryControlPlane();
  controlPlane.upsertMainUserProfile({ displayName: 'Alice', locale: 'en-US', timezone: 'UTC', metadata: { theme: 'dark' } });
  const updated = controlPlane.upsertMainUserProfile({ displayName: 'Bob' });
  assert.equal(updated.mainUser.displayName, 'Bob');
  assert.equal(updated.mainUser.locale, 'en-US');
  assert.equal(updated.mainUser.timezone, 'UTC');
  assert.deepEqual(updated.mainUser.metadata, { theme: 'dark' });
});

test('main user profile get returns same object as last upsert', () => {
  const controlPlane = new InMemoryControlPlane();
  const upserted = controlPlane.upsertMainUserProfile({ displayName: 'Alice' });
  const got = controlPlane.getMainUserProfile();
  assert.ok(got);
  assert.equal(got.id, upserted.mainUser.id);
  assert.equal(got.displayName, upserted.mainUser.displayName);
});

test('main user profile has retention metadata', () => {
  const controlPlane = new InMemoryControlPlane();
  const result = controlPlane.upsertMainUserProfile({ displayName: 'Alice' });
  assert.equal(result.mainUser.retentionClass, 'operational');
  assert.equal(result.mainUser.memorySpace, 'default');
  assert.equal(result.mainUser.sourceSystem, 'agentlink');
  assert.equal(result.mainUser.sensitivity, 'internal');
});

test('main user profile id is always main (singleton)', () => {
  const controlPlane = new InMemoryControlPlane();
  const first = controlPlane.upsertMainUserProfile({ displayName: 'A' });
  const second = controlPlane.upsertMainUserProfile({ displayName: 'B' });
  assert.equal(first.mainUser.id, 'main');
  assert.equal(second.mainUser.id, 'main');
  const got = controlPlane.getMainUserProfile();
  assert.ok(got);
  assert.equal(got.id, 'main');
});

test('channel user upsert creates and then reuses the same platform identity', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-13T00:00:00.000Z') });
  const first = controlPlane.upsertChannelUser({
    platform: ' Feishu ',
    externalId: ' OpenID-1 ',
    displayName: 'Alice',
    channelUserMetadata: { source: 'chat' },
    platformIdentityMetadata: { chat: 'oc_1' },
  });
  assert.equal(first.created, true);
  assert.equal(first.channelUser.category, 'unclassified');
  assert.equal(first.platformIdentity.platform, 'feishu');
  assert.equal(first.platformIdentity.normalizedExternalId, 'OpenID-1');
  assert.equal(first.platformIdentity.externalId, 'OpenID-1');
  assert.equal(first.channelUser.retentionClass, 'operational');

  const replay = controlPlane.upsertChannelUser({
    platform: 'feishu',
    externalId: 'OpenID-1',
    displayName: 'Alice Updated',
    platformIdentityMetadata: { chat: 'oc_2' },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.channelUser.id, first.channelUser.id);
  assert.equal(replay.platformIdentity.id, first.platformIdentity.id);
  assert.equal(replay.channelUser.displayName, 'Alice Updated');
  assert.deepEqual(replay.platformIdentity.metadata, { chat: 'oc_2' });
});

test('channel user upsert does not merge different platform or external_id', () => {
  const controlPlane = new InMemoryControlPlane();
  const feishu = controlPlane.upsertChannelUser({ platform: 'feishu', externalId: 'same-id' });
  const telegram = controlPlane.upsertChannelUser({ platform: 'telegram', externalId: 'same-id' });
  const caseDifferent = controlPlane.upsertChannelUser({ platform: 'feishu', externalId: 'Same-ID' });
  assert.notEqual(telegram.channelUser.id, feishu.channelUser.id);
  assert.notEqual(caseDifferent.channelUser.id, feishu.channelUser.id);
});

test('channel user category can be set and invalid/missing users are rejected', () => {
  const controlPlane = new InMemoryControlPlane();
  const created = controlPlane.upsertChannelUser({ platform: 'feishu', externalId: 'open-id' });
  const categorized = controlPlane.setChannelUserCategory({ channelUserId: created.channelUser.id, category: 'family.child' });
  assert.equal(categorized.channelUser.category, 'family.child');

  assert.throws(
    () => controlPlane.setChannelUserCategory({ channelUserId: created.channelUser.id, category: '-bad' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST',
  );
  assert.throws(
    () => controlPlane.setChannelUserCategory({ channelUserId: 'missing', category: 'family' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_CHANNEL_USER_NOT_FOUND',
  );
});

test('platform identity resolve returns found records and undefined for not found', () => {
  const controlPlane = new InMemoryControlPlane();
  const created = controlPlane.upsertChannelUser({ platform: 'Feishu', externalId: 'Open-ID' });
  const resolved = controlPlane.resolvePlatformIdentity({ platform: 'feishu', externalId: ' Open-ID ' });
  assert.ok(resolved);
  assert.equal(resolved.channelUser.id, created.channelUser.id);
  assert.equal(resolved.platformIdentity.id, created.platformIdentity.id);
  assert.equal(controlPlane.resolvePlatformIdentity({ platform: 'feishu', externalId: 'other' }), undefined);
});

test('group profile upsert creates defaults and reuses the same natural key', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-13T00:00:00.000Z') });
  const first = controlPlane.upsertGroupProfile({
    platform: ' Feishu ',
    externalGroupId: ' OC-1 ',
    displayName: '研发群',
    metadata: { source: 'chat' },
  });
  assert.equal(first.created, true);
  assert.equal(first.groupProfile.platform, 'feishu');
  assert.equal(first.groupProfile.externalGroupId, 'OC-1');
  assert.equal(first.groupProfile.normalizedExternalGroupId, 'OC-1');
  assert.equal(first.groupProfile.displayName, '研发群');
  assert.equal(first.groupProfile.groupType, 'general');
  assert.equal(first.groupProfile.tone, 'neutral');
  assert.equal(first.groupProfile.defaultReplyMode, 'thread');
  assert.equal(first.groupProfile.contextScope, 'group');
  assert.equal(first.groupProfile.memoryScope, 'group');
  assert.equal(first.groupProfile.retentionClass, 'operational');
  assert.equal(first.groupProfile.memorySpace, 'default');
  assert.equal(first.groupProfile.sourceSystem, 'agentlink');
  assert.equal(first.groupProfile.sensitivity, 'internal');

  const replay = controlPlane.upsertGroupProfile({
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
  assert.equal(replay.created, false);
  assert.equal(replay.groupProfile.id, first.groupProfile.id);
  assert.equal(replay.groupProfile.displayName, '研发群 updated');
  assert.equal(replay.groupProfile.groupType, 'team');
  assert.equal(replay.groupProfile.tone, 'formal');
  assert.equal(replay.groupProfile.defaultReplyMode, 'dialog');
  assert.equal(replay.groupProfile.contextScope, 'group.ops');
  assert.deepEqual(replay.groupProfile.metadata, { source: 'updated' });
});

test('group profile upsert does not merge different platform or external_group_id', () => {
  const controlPlane = new InMemoryControlPlane();
  const feishu = controlPlane.upsertGroupProfile({ platform: 'feishu', externalGroupId: 'same-id' });
  const telegram = controlPlane.upsertGroupProfile({ platform: 'telegram', externalGroupId: 'same-id' });
  const caseDifferent = controlPlane.upsertGroupProfile({ platform: 'feishu', externalGroupId: 'Same-ID' });
  assert.notEqual(telegram.groupProfile.id, feishu.groupProfile.id);
  assert.notEqual(caseDifferent.groupProfile.id, feishu.groupProfile.id);
});

test('group profile get, resolve, and default updates work with validation', () => {
  const controlPlane = new InMemoryControlPlane();
  const created = controlPlane.upsertGroupProfile({ platform: 'Feishu', externalGroupId: ' OC-1 ' });
  assert.equal(controlPlane.getGroupProfile(created.groupProfile.id)?.id, created.groupProfile.id);

  const resolved = controlPlane.resolveGroupProfile({ platform: 'feishu', externalGroupId: 'OC-1' });
  assert.ok(resolved);
  assert.equal(resolved.id, created.groupProfile.id);
  assert.equal(controlPlane.resolveGroupProfile({ platform: 'feishu', externalGroupId: 'missing' }), undefined);

  const updated = controlPlane.setGroupProfileDefaults({
    groupProfileId: created.groupProfile.id,
    defaultReplyMode: 'dialog',
    contextScope: 'group.support',
    memoryScope: 'group.support',
    tone: 'friendly',
  });
  assert.equal(updated.groupProfile.defaultReplyMode, 'dialog');
  assert.equal(updated.groupProfile.contextScope, 'group.support');
  assert.equal(updated.groupProfile.memoryScope, 'group.support');
  assert.equal(updated.groupProfile.tone, 'friendly');

  assert.throws(
    () => controlPlane.setGroupProfileDefaults({ groupProfileId: created.groupProfile.id, defaultReplyMode: 'stream' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST',
  );
  assert.throws(
    () => controlPlane.setGroupProfileDefaults({ groupProfileId: 'missing', defaultReplyMode: 'thread' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_GROUP_PROFILE_NOT_FOUND',
  );
});

test('source event ingest creates one SourceEvent/Entry and repeats idempotently by source hash', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-15T00:00:00.000Z'), sourceHashSecret: 'test-secret' });
  const speaker = controlPlane.upsertChannelUser({ platform: 'feishu', externalId: 'ou_1' });
  const group = controlPlane.upsertGroupProfile({ platform: 'feishu', externalGroupId: 'oc_1' });
  const first = controlPlane.ingestSourceEvent({
    sourceSystem: ' FeiShu ',
    sourceRef: ' msg-1 ',
    eventType: 'message.receive',
    platform: 'Feishu',
    occurredAt: '2026-06-14T23:59:00.000Z',
    payload: { raw: true },
    metadata: { trace: 't1' },
    entryType: 'group',
    externalChatId: ' oc_1 ',
    externalThreadId: ' thread_1 ',
    externalMessageId: ' msg_1 ',
    speakerChannelUserId: speaker.channelUser.id,
    groupProfileId: group.groupProfile.id,
    agentMentioned: true,
    bodyText: 'hello',
    entryMetadata: { parsed: true },
  });
  assert.equal(first.created, true);
  assert.equal(first.sourceEvent.sourceSystem, 'feishu');
  assert.equal(first.sourceEvent.sourceRef, 'msg-1');
  assert.match(first.sourceEvent.sourceHash, /^hmac-sha256:v1:[0-9a-f]{64}$/);
  assert.equal(first.sourceEvent.retentionClass, 'short_term');
  assert.equal(first.sourceEvent.memorySpace, 'default');
  assert.equal(first.entry.sourceSystem, 'feishu');
  assert.equal(first.entry.entryType, 'group');
  assert.equal(first.entry.externalChatId, 'oc_1');
  assert.equal(first.entry.speakerChannelUserId, speaker.channelUser.id);
  assert.equal(first.entry.groupProfileId, group.groupProfile.id);
  assert.equal(first.entry.agentMentioned, true);

  const replay = controlPlane.ingestSourceEvent({ sourceSystem: 'feishu', sourceRef: 'msg-1', eventType: 'message.receive', bodyText: 'ignored' });
  assert.equal(replay.created, false);
  assert.equal(replay.sourceEvent.id, first.sourceEvent.id);
  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(replay.entry.bodyText, 'hello');

  assert.equal(controlPlane.resolveSourceEvent({ sourceSystem: 'Feishu', sourceRef: ' msg-1 ' })?.id, first.sourceEvent.id);
  assert.equal(controlPlane.getSourceEvent(first.sourceEvent.id)?.id, first.sourceEvent.id);
  assert.equal(controlPlane.getEntry(first.entry.id)?.id, first.entry.id);
  assert.equal(controlPlane.getEntryBySourceEvent(first.sourceEvent.id)?.id, first.entry.id);
});

test('source event ingest keeps source_system/source_ref boundaries and rejects missing optional refs', () => {
  const controlPlane = new InMemoryControlPlane({ sourceHashSecret: 'test-secret' });
  const a = controlPlane.ingestSourceEvent({ sourceSystem: 'feishu', sourceRef: 'same', eventType: 'message', bodyText: 'a' });
  const b = controlPlane.ingestSourceEvent({ sourceSystem: 'telegram', sourceRef: 'same', eventType: 'message', bodyText: 'b' });
  const c = controlPlane.ingestSourceEvent({ sourceSystem: 'feishu', sourceRef: 'Same', eventType: 'message', bodyText: 'c' });
  assert.notEqual(b.sourceEvent.id, a.sourceEvent.id);
  assert.notEqual(c.sourceEvent.id, a.sourceEvent.id);

  assert.throws(
    () => controlPlane.ingestSourceEvent({ sourceSystem: 'feishu', sourceRef: 'missing-user', eventType: 'message', speakerChannelUserId: 'missing' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_CHANNEL_USER_NOT_FOUND',
  );
  assert.throws(
    () => controlPlane.ingestSourceEvent({ sourceSystem: 'feishu', sourceRef: 'missing-group', eventType: 'message', groupProfileId: 'missing' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_GROUP_PROFILE_NOT_FOUND',
  );
});

test('session resolve creates large session for dm and is idempotent with entry backfill', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-15T00:00:00.000Z') });
  const ingested = controlPlane.ingestSourceEvent({
    sourceSystem: 'fake-im',
    sourceRef: 'session-dm-1',
    eventType: 'message.receive',
    platform: 'fake-im',
    entryType: 'dm',
    externalMessageId: 'dm-msg-1',
    bodyText: 'hello dm',
  });

  const resolved = controlPlane.resolveSession({ entryId: ingested.entry.id });
  assert.equal(resolved.created, true);
  assert.equal(resolved.largeSession.sessionScope, 'large');
  assert.equal(resolved.smallSession, undefined);
  assert.equal(resolved.session.id, resolved.largeSession.id);
  assert.equal(resolved.entry.sessionId, resolved.session.id);
  assert.equal(controlPlane.getEntry(ingested.entry.id)?.sessionId, resolved.session.id);

  const replay = controlPlane.resolveSession({ entryId: ingested.entry.id });
  assert.equal(replay.created, false);
  assert.equal(replay.session.id, resolved.session.id);
  assert.equal(replay.entry.sessionId, resolved.session.id);
});

test('session resolve creates large plus small for thread and does not create small for non-thread group', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-15T00:00:00.000Z') });
  const groupProfile = controlPlane.upsertGroupProfile({ platform: 'fake-im', externalGroupId: 'oc_session', defaultReplyMode: 'dialog' }).groupProfile;
  const group = controlPlane.ingestSourceEvent({
    sourceSystem: 'fake-im',
    sourceRef: 'session-group-1',
    eventType: 'message.receive',
    platform: 'fake-im',
    entryType: 'group',
    externalChatId: 'oc_session',
    externalMessageId: 'group-msg-1',
    groupProfileId: groupProfile.id,
    bodyText: 'hello group',
  });
  const groupResolved = controlPlane.resolveSession({ entryId: group.entry.id });
  assert.equal(groupResolved.created, true);
  assert.equal(groupResolved.largeSession.sessionScope, 'large');
  assert.equal(groupResolved.smallSession, undefined);
  assert.equal(groupResolved.entry.sessionId, groupResolved.largeSession.id);

  const thread = controlPlane.ingestSourceEvent({
    sourceSystem: 'fake-im',
    sourceRef: 'session-thread-1',
    eventType: 'message.receive',
    platform: 'fake-im',
    entryType: 'thread',
    externalChatId: 'oc_session',
    externalThreadId: 'thread_1',
    externalMessageId: 'thread-msg-1',
    groupProfileId: groupProfile.id,
    bodyText: 'hello thread',
  });
  const threadResolved = controlPlane.resolveSession({ entryId: thread.entry.id });
  assert.equal(threadResolved.largeSession.id, groupResolved.largeSession.id);
  assert.ok(threadResolved.smallSession);
  assert.equal(threadResolved.smallSession.parentSessionId, threadResolved.largeSession.id);
  assert.equal(threadResolved.session.id, threadResolved.smallSession.id);
  assert.equal(threadResolved.entry.sessionId, threadResolved.smallSession.id);

  const lookup = controlPlane.getEntrySession(thread.entry.id);
  assert.equal(lookup?.session.id, threadResolved.smallSession.id);
});

test('memory candidate create is explicit, idempotent per session, and status-reviewable', () => {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-11T00:00:00.000Z') });
  const ingested = controlPlane.ingestSourceEvent({
    sourceSystem: 'fake-im',
    sourceRef: 'memory-candidate:dm:1',
    eventType: 'message.receive',
    platform: 'fake-im',
    entryType: 'dm',
    externalChatId: 'dm-chat-1',
    externalMessageId: 'dm-msg-1',
    bodyText: '用户喜欢简洁回复',
  });
  const resolved = controlPlane.resolveSession({ entryId: ingested.entry.id });
  assert.deepEqual(controlPlane.listMemoryCandidates(resolved.session.id), []);

  const first = controlPlane.createMemoryCandidate({
    sessionId: resolved.session.id,
    entryId: ingested.entry.id,
    sourceEventId: ingested.sourceEvent.id,
    candidateText: ' 用户喜欢简洁回复 ',
    confidence: 0.8765,
    metadata: { extractor: 'manual' },
  });
  assert.equal(first.created, true);
  assert.equal(first.memoryCandidate.status, 'pending');
  assert.equal(first.memoryCandidate.candidateText, '用户喜欢简洁回复');
  assert.equal(first.memoryCandidate.confidence, 0.877);
  assert.equal(first.memoryCandidate.retentionClass, 'memory_candidate');
  assert.equal(first.memoryCandidate.entryId, ingested.entry.id);
  assert.equal(first.memoryCandidate.sourceEventId, ingested.sourceEvent.id);

  const replay = controlPlane.createMemoryCandidate({ sessionId: resolved.session.id, candidateText: '用户喜欢简洁回复' });
  assert.equal(replay.created, false);
  assert.equal(replay.memoryCandidate.id, first.memoryCandidate.id);
  assert.deepEqual(controlPlane.listMemoryCandidates(resolved.session.id).map((candidate) => candidate.id), [first.memoryCandidate.id]);

  const updated = controlPlane.setMemoryCandidateStatus({ memoryCandidateId: first.memoryCandidate.id, status: 'accepted', reason: 'reviewed' });
  assert.equal(updated.memoryCandidate.status, 'accepted');
  assert.equal(updated.memoryCandidate.reason, 'reviewed');
  assert.equal(controlPlane.getMemoryCandidate(first.memoryCandidate.id)?.status, 'accepted');
});

test('memory candidate create validates referenced session, entry, source event, and status', () => {
  const controlPlane = new InMemoryControlPlane();
  assert.throws(
    () => controlPlane.createMemoryCandidate({ sessionId: 'missing-session', candidateText: 'remember this' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_SESSION_NOT_FOUND',
  );
  const ingested = controlPlane.ingestSourceEvent({
    sourceSystem: 'fake-im',
    sourceRef: 'memory-candidate:dm:2',
    eventType: 'message.receive',
    platform: 'fake-im',
    entryType: 'dm',
    externalChatId: 'dm-chat-2',
    externalMessageId: 'dm-msg-2',
    bodyText: '用户喜欢结构化输出',
  });
  const session = controlPlane.resolveSession({ entryId: ingested.entry.id }).session;
  assert.throws(
    () => controlPlane.createMemoryCandidate({ sessionId: session.id, entryId: 'missing-entry', candidateText: 'remember this' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_ENTRY_NOT_FOUND',
  );
  assert.throws(
    () => controlPlane.createMemoryCandidate({ sessionId: session.id, sourceEventId: 'missing-event', candidateText: 'remember this' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_SOURCE_EVENT_NOT_FOUND',
  );
  const candidate = controlPlane.createMemoryCandidate({ sessionId: session.id, candidateText: 'remember this' }).memoryCandidate;
  assert.throws(
    () => controlPlane.setMemoryCandidateStatus({ memoryCandidateId: candidate.id, status: 'published' }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST',
  );
});
