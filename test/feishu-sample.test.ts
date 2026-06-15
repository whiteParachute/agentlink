import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentlinkError } from '../src/control-plane/errors.js';
import type { JsonRecord } from '../src/domain/entities.js';
import {
  buildFeishuSampleSourceRef,
  FEISHU_SAMPLE_EVENT_TYPE,
  FEISHU_SAMPLE_PLATFORM,
  FEISHU_SAMPLE_SOURCE_SYSTEM,
  mapFeishuSampleEventToIngest,
  normalizeFeishuSampleEvent,
  toFeishuSampleEventDto,
} from '../src/domain/feishu-sample.js';

function fixture(name: 'dm' | 'group' | 'thread-reply'): JsonRecord {
  return JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'feishu', `${name}.json`), 'utf8')) as JsonRecord;
}

void test('Feishu sample mapper normalizes dm, group, and thread fixtures into ingress shape', () => {
  const dm = normalizeFeishuSampleEvent(fixture('dm'));
  assert.equal(dm.kind, 'dm');
  assert.equal(dm.chatId, 'oc_feishu_p2p_001');
  assert.equal(dm.messageId, 'om_feishu_dm_001');
  assert.equal(dm.text, 'hello from feishu dm');
  assert.equal(dm.agentMentioned, false);
  assert.equal(dm.occurredAt, '2026-06-15T09:00:00.000Z');
  assert.equal(buildFeishuSampleSourceRef(dm), 'feishu:dm:oc_feishu_p2p_001:none:om_feishu_dm_001');

  const group = normalizeFeishuSampleEvent(fixture('group'));
  assert.equal(group.kind, 'group');
  assert.equal(group.agentMentioned, true);
  assert.match(group.text, /Agentlink/);
  assert.equal(buildFeishuSampleSourceRef(group), 'feishu:group:oc_feishu_group_001:none:om_feishu_group_001');

  const thread = normalizeFeishuSampleEvent(fixture('thread-reply'));
  assert.equal(thread.kind, 'thread');
  assert.equal(thread.rootId, 'om_feishu_thread_root_001');
  assert.equal(thread.parentId, 'om_feishu_parent_001');
  assert.equal(thread.threadId, 'om_feishu_thread_root_001');
  assert.equal(buildFeishuSampleSourceRef(thread), 'feishu:thread:oc_feishu_group_001:om_feishu_thread_root_001:om_feishu_thread_reply_001');

  const ingest = mapFeishuSampleEventToIngest(thread);
  assert.equal(ingest.sourceSystem, FEISHU_SAMPLE_SOURCE_SYSTEM);
  assert.equal(ingest.platform, FEISHU_SAMPLE_PLATFORM);
  assert.equal(ingest.eventType, FEISHU_SAMPLE_EVENT_TYPE);
  assert.equal(ingest.entryType, 'thread');
  assert.equal(ingest.externalChatId, 'oc_feishu_group_001');
  assert.equal(ingest.externalThreadId, 'om_feishu_thread_root_001');
  assert.equal(ingest.externalMessageId, 'om_feishu_thread_reply_001');
  assert.equal(ingest.bodyText, 'reply in feishu thread');
  assert.equal((ingest.metadata.feishu as { parent_id: string }).parent_id, 'om_feishu_parent_001');
  assert.equal((ingest.metadata.feishu as { reply_to_message_id: string }).reply_to_message_id, 'om_feishu_parent_001');
  assert.deepEqual((ingest.payload.feishu_event as { event: JsonRecord }).event, fixture('thread-reply').event);

  const dto = toFeishuSampleEventDto(thread);
  assert.equal(dto.message_id, 'om_feishu_thread_reply_001');
  assert.equal(dto.chat_id, 'oc_feishu_group_001');
  assert.equal(dto.thread_id, 'om_feishu_thread_root_001');
  assert.equal(dto.parent_id, 'om_feishu_parent_001');
  assert.equal(dto.source_ref, 'feishu:thread:oc_feishu_group_001:om_feishu_thread_root_001:om_feishu_thread_reply_001');
  assert.equal((dto as { messageId?: string }).messageId, undefined);
});

void test('Feishu sample source_ref is stable and escapes delimiter-bearing refs', () => {
  const raw = fixture('dm');
  const message = ((raw.event as JsonRecord).message as JsonRecord);
  message.message_id = 'om:1';
  message.chat_id = 'oc:dm';
  const event = normalizeFeishuSampleEvent(raw);
  assert.equal(buildFeishuSampleSourceRef(event), buildFeishuSampleSourceRef(event));
  assert.equal(buildFeishuSampleSourceRef(event), 'feishu:dm:oc%3Adm:none:om%3A1');
});

void test('Feishu sample validation rejects unsupported or malformed payloads fail-closed', () => {
  const base = fixture('thread-reply');
  const cases: Array<(input: JsonRecord) => void> = [
    (input) => { delete ((input.event as JsonRecord).message as JsonRecord).message_id; },
    (input) => { delete ((input.event as JsonRecord).message as JsonRecord).chat_id; },
    (input) => { ((input.event as JsonRecord).message as JsonRecord).message_type = 'image'; },
    (input) => { ((input.event as JsonRecord).message as JsonRecord).content = '{bad json'; },
    (input) => { ((input.event as JsonRecord).message as JsonRecord).content = JSON.stringify({ rich_text: 'not text' }); },
    (input) => { ((input.event as JsonRecord).message as JsonRecord).root_id = ''; },
    (input) => { input.metadata = []; },
    (input) => { (input.header as JsonRecord).event_type = 'im.message.recalled_v1'; },
  ];
  for (const mutate of cases) {
    const input = JSON.parse(JSON.stringify(base)) as JsonRecord;
    mutate(input);
    assert.throws(() => normalizeFeishuSampleEvent(input), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  }
});
