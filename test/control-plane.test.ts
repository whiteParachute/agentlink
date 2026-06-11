import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryControlPlane } from '../src/control-plane/in-memory.js';
import { AgentlinkError } from '../src/control-plane/errors.js';

function bootstrap() {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date('2026-06-11T00:00:00.000Z') });
  const registered = controlPlane.registerDevice({ displayName: 'claw-tenc', ownerUserId: 'whiteParachute' });
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

  const second = controlPlane.pull({ deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.equal(second, undefined);
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
