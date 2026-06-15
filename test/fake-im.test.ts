import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import {
  buildFakeImSourceRef,
  FAKE_IM_EVENT_TYPE,
  FAKE_IM_SOURCE_SYSTEM,
  mapFakeImEventToIngest,
  normalizeFakeImEvent,
  toFakeImEventDto,
} from '../src/domain/fake-im.js';

void test('fake IM mapper normalizes camel and snake input into AL-M1-006 ingest shape', () => {
  const event = normalizeFakeImEvent({
    kind: 'thread',
    messageId: ' msg-1 ',
    chat_id: ' oc_1 ',
    threadId: ' thread_1 ',
    reply_to_message_id: ' parent_1 ',
    text: 'hello fake im',
    speaker_channel_user_id: '00000000-0000-4000-8000-000000000001',
    groupProfileId: '00000000-0000-4000-8000-000000000002',
    agentMentioned: true,
    occurred_at: '2026-06-15T00:00:00.000Z',
    metadata: { trace: 't1' },
  });

  assert.equal(event.kind, 'thread');
  assert.equal(event.messageId, 'msg-1');
  assert.equal(event.chatId, 'oc_1');
  assert.equal(event.threadId, 'thread_1');
  assert.equal(event.replyToMessageId, 'parent_1');
  assert.equal(event.agentMentioned, true);
  assert.equal(event.occurredAt, '2026-06-15T00:00:00.000Z');
  assert.equal(buildFakeImSourceRef(event), 'fake-im:thread:oc_1:thread_1:msg-1');

  const ingest = mapFakeImEventToIngest(event);
  assert.equal(ingest.sourceSystem, FAKE_IM_SOURCE_SYSTEM);
  assert.equal(ingest.platform, FAKE_IM_SOURCE_SYSTEM);
  assert.equal(ingest.eventType, FAKE_IM_EVENT_TYPE);
  assert.equal(ingest.sourceRef, 'fake-im:thread:oc_1:thread_1:msg-1');
  assert.equal(ingest.entryType, 'thread');
  assert.equal(ingest.externalChatId, 'oc_1');
  assert.equal(ingest.externalThreadId, 'thread_1');
  assert.equal(ingest.externalMessageId, 'msg-1');
  assert.equal(ingest.bodyText, 'hello fake im');
  assert.deepEqual((ingest.payload.fake_im_event as { reply_to_message_id: string }).reply_to_message_id, 'parent_1');
  assert.deepEqual((ingest.metadata.fake_im as { reply_to_message_id: string }).reply_to_message_id, 'parent_1');

  const dto = toFakeImEventDto(event);
  assert.equal(dto.message_id, 'msg-1');
  assert.equal(dto.reply_to_message_id, 'parent_1');
  assert.equal(dto.source_ref, 'fake-im:thread:oc_1:thread_1:msg-1');
});

void test('fake IM source_ref is stable and escapes delimiter-bearing refs', () => {
  const event = normalizeFakeImEvent({ kind: 'dm', message_id: 'msg:1', text: 'hello' });
  assert.equal(buildFakeImSourceRef(event), buildFakeImSourceRef(event));
  assert.equal(buildFakeImSourceRef(event), 'fake-im:dm:dm:none:msg%3A1');
  const withChat = normalizeFakeImEvent({ kind: 'dm', message_id: 'msg:1', chat_id: 'dm:alice', text: 'hello' });
  assert.equal(buildFakeImSourceRef(withChat), 'fake-im:dm:dm%3Aalice:none:msg%3A1');
});

void test('fake IM validation rejects invalid shape fail-closed', () => {
  const cases: Array<() => unknown> = [
    () => normalizeFakeImEvent({ kind: 'web', message_id: 'msg', text: 'x' }),
    () => normalizeFakeImEvent({ kind: 'dm', text: 'x' }),
    () => normalizeFakeImEvent({ kind: 'group', message_id: 'msg', text: 'x' }),
    () => normalizeFakeImEvent({ kind: 'thread', message_id: 'msg', chat_id: 'oc', text: 'x' }),
    () => normalizeFakeImEvent({ kind: 'dm', message_id: '', text: 'x' }),
    () => normalizeFakeImEvent({ kind: 'dm', message_id: 'msg', agent_mentioned: 'yes' }),
    () => normalizeFakeImEvent({ kind: 'dm', message_id: 'msg', metadata: [] }),
    () => normalizeFakeImEvent({ kind: 'dm', messageId: 'a', message_id: 'b' }),
    () => normalizeFakeImEvent({ kind: 'dm', message_id: 'msg', occurred_at: 'bad-date' }),
  ];
  for (const fn of cases) {
    assert.throws(fn, (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  }
});
