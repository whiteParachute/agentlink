import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import type { EntryRecord, GroupProfileRecord, JsonRecord, SessionRecord } from '../src/domain/entities.js';
import { assertNoRawMessageContent, buildEntryRouteIdempotencyKey, buildMainAgentRouteTask } from '../src/domain/main-agent.js';

const NOW = '2026-06-15T00:00:00.000Z';

function entry(overrides: Partial<EntryRecord> = {}): EntryRecord {
  return {
    id: 'entry-1',
    sourceEventId: 'source-event-1',
    entryType: 'thread',
    platform: 'fake-im',
    externalChatId: 'oc_1',
    externalThreadId: 'thread_1',
    externalMessageId: 'msg-1',
    sessionId: 'session-1',
    agentMentioned: true,
    bodyText: 'raw text must not enter task payload',
    metadata: { fake_im: { reply_to_message_id: 'parent-1' } },
    retentionClass: 'short_term',
    memorySpace: 'default',
    sourceSystem: 'fake-im',
    sensitivity: 'internal',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    sessionScope: 'small',
    platform: 'fake-im',
    externalChatId: 'oc_1',
    externalThreadId: 'thread_1',
    parentSessionId: 'large-session-1',
    naturalKey: 'thread:fake-im:oc_1:thread_1',
    displayName: 'Thread session',
    metadata: {},
    retentionClass: 'operational',
    memorySpace: 'default',
    sourceSystem: 'agentlink',
    sensitivity: 'internal',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function groupProfile(): GroupProfileRecord {
  return {
    id: 'group-profile-1',
    platform: 'fake-im',
    externalGroupId: 'oc_1',
    normalizedExternalGroupId: 'oc_1',
    displayName: 'Group',
    groupType: 'general',
    tone: 'neutral',
    defaultReplyMode: 'thread',
    contextScope: 'group',
    memoryScope: 'group',
    metadata: {},
    retentionClass: 'operational',
    memorySpace: 'default',
    sourceSystem: 'agentlink',
    sensitivity: 'internal',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

test('main agent route task is idempotent and carries only references plus reply mode', () => {
  assert.equal(buildEntryRouteIdempotencyKey(' entry-1 '), 'entry-route:entry-1');
  const draft = buildMainAgentRouteTask({ entry: entry(), session: session(), groupProfile: groupProfile() });

  assert.equal(draft.idempotencyKey, 'entry-route:entry-1');
  assert.equal(draft.taskInput.source, 'main-agent');
  assert.equal(draft.taskInput.sourceRef, 'entry-1');
  assert.equal(draft.taskInput.maxRetries, 1);
  assert.deepEqual(draft.taskInput.payload, {
    entry_id: 'entry-1',
    session_id: 'session-1',
    source_event_id: 'source-event-1',
    reply_mode: {
      reply_mode: 'thread',
      target: 'thread',
      in_thread: true,
      reply_to_message_id: 'parent-1',
      reason: 'thread_entry;agent_mentioned',
    },
    memory_candidate_ids: [],
    memory_ids: [],
  });
  assert.equal((draft.taskInput.taskSpec.input as JsonRecord).entry_id, 'entry-1');
  assert.equal((draft.taskInput.taskSpec.reply_mode as JsonRecord).reply_mode, 'thread');
  assert.equal(stringify(draft.taskInput.payload).includes('raw text must not enter task payload'), false);
  assert.equal(stringify(draft.taskInput.taskSpec).includes('raw text must not enter task payload'), false);
  assert.equal('body_text' in draft.taskInput.payload, false);
  assert.equal('bodyText' in draft.taskInput.payload, false);
});

test('main agent route task fails closed for unresolved or mismatched sessions and raw fields', () => {
  const unresolved = entry();
  delete unresolved.sessionId;
  assert.throws(
    () => buildMainAgentRouteTask({ entry: unresolved, session: session() }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST',
  );
  assert.throws(
    () => buildMainAgentRouteTask({ entry: entry(), session: session({ id: 'different-session' }) }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST',
  );
  assert.throws(
    () => assertNoRawMessageContent({ nested: { body_text: 'raw' } }),
    (error) => error instanceof AgentlinkError && error.code === 'AL_INTERNAL',
  );
});
