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
