import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WORKSPACE, InMemoryControlPlane } from '../src/control-plane/in-memory.js';
import { daemonStep } from '../src/agentlet/daemon.js';
import { FakeRunnerAdapter } from '../src/agentlet/fake-runner.js';

const NOW = '2026-06-11T00:00:00.000Z';

function bootstrap() {
  const controlPlane = new InMemoryControlPlane({ now: () => new Date(NOW) });
  const registered = controlPlane.registerDevice({
    displayName: 'claw-tenc',
    ownerUserId: 'whiteParachute',
    capabilityGrants: ['codex:exec'],
    workdirGrants: [{ pathPrefix: DEFAULT_WORKSPACE, accessMode: 'read_write' }],
  });
  controlPlane.heartbeat(registered.device.id, registered.deviceSecret);
  return { controlPlane, registered };
}

test('daemonStep returns idle when there is no queued work', async () => {
  const { controlPlane, registered } = bootstrap();
  const runner = new FakeRunnerAdapter({ status: 'SUCCEEDED' });
  const outcome = await daemonStep({ controlPlane, runner }, { deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.equal(outcome.kind, 'idle');
});

test('daemonStep consumes a queued task to a terminal SUCCEEDED run with observable events', async () => {
  const { controlPlane, registered } = bootstrap();
  controlPlane.createTask({ source: 'telegram', sourceRef: 'telegram:chat:msg', payload: { text: 'hello codex' } }, 'idem-daemon-1');
  const runner = new FakeRunnerAdapter({
    status: 'SUCCEEDED',
    events: [
      { eventType: 'STDOUT', payload: { text: 'working' } },
      { eventType: 'FINAL', payload: { text: 'done' } },
    ],
    result: { summary: 'ok' },
  });

  const outcome = await daemonStep({ controlPlane, runner }, { deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.equal(outcome.kind, 'completed');
  if (outcome.kind !== 'completed') return;
  assert.equal(outcome.run.status, 'SUCCEEDED');
  assert.equal(outcome.task.status, 'SUCCEEDED');

  const events = controlPlane.getRunEvents(outcome.run.id);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.seq, 1);
  assert.equal(events[1]?.seq, 2);
});

test('daemonStep drives a FAILED runner result to a terminal FAILED run', async () => {
  const { controlPlane, registered } = bootstrap();
  controlPlane.createTask({ source: 'telegram', sourceRef: 'telegram:chat:fail', payload: { text: 'boom' } }, 'idem-daemon-fail');
  const runner = new FakeRunnerAdapter({ status: 'FAILED', error: { code: 'X', message: 'nope' } });

  const outcome = await daemonStep({ controlPlane, runner }, { deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.equal(outcome.run.status, 'FAILED');
});

test('daemonStep treats a thrown runner as a terminal FAILED run instead of dangling the lease', async () => {
  const { controlPlane, registered } = bootstrap();
  controlPlane.createTask({ source: 'telegram', sourceRef: 'telegram:chat:throw', payload: { text: 'x' } }, 'idem-daemon-throw');
  const runner = new FakeRunnerAdapter({ status: 'SUCCEEDED', throwError: new Error('runner crashed') });

  const outcome = await daemonStep({ controlPlane, runner }, { deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.equal(outcome.run.status, 'FAILED');
});

test('memory-first vertical: ingress to session resolve to route-task to daemon terminal complete', async () => {
  const { controlPlane, registered } = bootstrap();
  const ingested = controlPlane.ingestSourceEvent({
    sourceSystem: 'fake-im',
    sourceRef: 'fake-im:dm:msg-1',
    eventType: 'message.receive',
    platform: 'fake-im',
    entryType: 'dm',
    externalChatId: 'oc_vertical',
    externalMessageId: 'msg-1',
    bodyText: 'remember this private secret body',
  });
  const resolved = controlPlane.resolveSession({ entryId: ingested.entry.id });
  assert.ok(resolved.session.id);
  const routed = controlPlane.routeEntryToTask({ entryId: ingested.entry.id });
  assert.equal(routed.task.status, 'QUEUED');

  const runner = new FakeRunnerAdapter({ status: 'SUCCEEDED', events: [{ eventType: 'STDOUT', payload: { text: 'consumed' } }] });
  const outcome = await daemonStep({ controlPlane, runner }, { deviceId: registered.device.id, runnerId: registered.runner.id });
  assert.equal(outcome.kind, 'completed');
  if (outcome.kind !== 'completed') return;
  assert.equal(outcome.run.status, 'SUCCEEDED');
  assert.equal(outcome.task.id, routed.task.id);

  // no-raw guard: the routed task payload must not leak the raw inbound body.
  const serializedTask = JSON.stringify(outcome.task);
  assert.ok(!serializedTask.includes('remember this private secret body'));
});
