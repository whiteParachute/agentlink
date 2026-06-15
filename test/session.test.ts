import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import type { EntryRecord } from '../src/domain/entities.js';
import { buildLargeSessionNaturalKey, buildSmallThreadSessionNaturalKey, planSessionForEntry } from '../src/domain/session.js';

const BASE_ENTRY: EntryRecord = {
  id: 'entry-1',
  sourceEventId: 'source-1',
  entryType: 'group',
  platform: 'fake-im',
  externalChatId: 'oc_1',
  externalMessageId: 'msg_1',
  agentMentioned: false,
  bodyText: 'hello',
  metadata: {},
  retentionClass: 'short_term',
  memorySpace: 'default',
  sourceSystem: 'fake-im',
  sensitivity: 'internal',
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z',
};

test('session natural keys are stable and delimiter-safe', () => {
  assert.equal(buildLargeSessionNaturalKey('group', 'Feishu'.toLowerCase(), 'oc:with/slash'), 'group:feishu:oc%3Awith%2Fslash');
  assert.equal(buildSmallThreadSessionNaturalKey('fake-im', 'oc:1', 'thread/1'), 'thread:fake-im:oc%3A1:thread%2F1');
});

test('session planner assigns dm and non-thread group entries to large sessions only', () => {
  const dmEntry = { ...BASE_ENTRY, entryType: 'dm' as const, speakerChannelUserId: 'speaker-1' };
  delete dmEntry.externalChatId;
  const dmPlan = planSessionForEntry(dmEntry);
  assert.equal(dmPlan.large.sessionScope, 'large');
  assert.equal(dmPlan.large.naturalKey, 'dm:fake-im:speaker-1');
  assert.equal(dmPlan.small, undefined);
  assert.equal(dmPlan.targetScope, 'large');

  const groupPlan = planSessionForEntry(BASE_ENTRY);
  assert.equal(groupPlan.large.sessionScope, 'large');
  assert.equal(groupPlan.large.naturalKey, 'group:fake-im:oc_1');
  assert.equal(groupPlan.small, undefined);
  assert.equal(groupPlan.targetScope, 'large');
});

test('session planner creates large plus small sessions for thread signals', () => {
  const plan = planSessionForEntry({ ...BASE_ENTRY, entryType: 'thread', externalThreadId: 'thread_1' });
  assert.equal(plan.large.naturalKey, 'group:fake-im:oc_1');
  assert.equal(plan.small?.sessionScope, 'small');
  assert.equal(plan.small?.naturalKey, 'thread:fake-im:oc_1:thread_1');
  assert.equal(plan.targetScope, 'small');

  const replyPlan = planSessionForEntry({ ...BASE_ENTRY, metadata: { fake_im: { reply_to_message_id: 'msg-root' } } });
  assert.equal(replyPlan.small?.naturalKey, 'thread:fake-im:oc_1:msg-root');
});

test('session planner falls back web and unknown entries to large sessions', () => {
  const webEntry = { ...BASE_ENTRY, entryType: 'web' as const, platform: 'web', externalMessageId: 'web-msg' };
  delete webEntry.externalChatId;
  const webPlan = planSessionForEntry(webEntry);
  assert.equal(webPlan.large.sessionScope, 'large');
  assert.equal(webPlan.large.naturalKey, 'fallback:web:web-msg');
  assert.equal(webPlan.small, undefined);
});

test('session planner rejects malformed thread entries fail-closed', () => {
  assert.throws(
    () => {
      const entry = { ...BASE_ENTRY, entryType: 'thread' as const, externalThreadId: 'thread_1' };
      delete entry.externalChatId;
      return planSessionForEntry(entry);
    },
    (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST',
  );
});
