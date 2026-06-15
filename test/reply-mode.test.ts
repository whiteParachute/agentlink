import test from 'node:test';
import assert from 'node:assert/strict';
import type { EntryRecord, EntryType, GroupProfileRecord, JsonRecord, ReplyMode } from '../src/domain/entities.js';
import { readReplyToMessageId, resolveReplyMode } from '../src/domain/reply-mode.js';

const NOW = '2026-06-15T00:00:00.000Z';

function entry(overrides: Partial<EntryRecord> = {}): EntryRecord {
  return {
    id: 'entry-1',
    sourceEventId: 'source-event-1',
    entryType: 'dm',
    platform: 'fake-im',
    externalMessageId: 'msg-1',
    agentMentioned: false,
    bodyText: 'hello',
    metadata: {},
    retentionClass: 'short_term',
    memorySpace: 'default',
    sourceSystem: 'fake-im',
    sensitivity: 'internal',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function groupProfile(defaultReplyMode: ReplyMode): GroupProfileRecord {
  return {
    id: 'group-profile-1',
    platform: 'fake-im',
    externalGroupId: 'oc_1',
    normalizedExternalGroupId: 'oc_1',
    displayName: 'Group',
    groupType: 'general',
    tone: 'neutral',
    defaultReplyMode,
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

void test('reply mode resolver keeps dm direct dialog and ignores mention for routing', () => {
  const resolution = resolveReplyMode({ entry: entry({ entryType: 'dm', agentMentioned: true }) });
  assert.deepEqual(resolution, {
    replyMode: 'dialog',
    target: 'direct',
    inThread: false,
    reason: 'dm_entry_dialog;agent_mentioned',
  });
});

void test('reply mode resolver defaults plain groups to thread unless profile says dialog', () => {
  assert.deepEqual(resolveReplyMode({ entry: entry({ entryType: 'group', externalChatId: 'oc_1' }) }), {
    replyMode: 'thread',
    target: 'thread',
    inThread: false,
    reason: 'group_default_thread',
  });

  assert.deepEqual(resolveReplyMode({ entry: entry({ entryType: 'group', externalChatId: 'oc_1' }), groupProfile: groupProfile('dialog') }), {
    replyMode: 'dialog',
    target: 'channel',
    inThread: false,
    reason: 'group_profile_dialog',
  });

  assert.deepEqual(resolveReplyMode({ entry: entry({ entryType: 'group', externalChatId: 'oc_1' }), groupProfile: groupProfile('thread') }), {
    replyMode: 'thread',
    target: 'thread',
    inThread: false,
    reason: 'group_profile_thread',
  });
});

void test('reply mode resolver upgrades thread entries, external thread refs, and reply metadata to thread target', () => {
  assert.deepEqual(resolveReplyMode({ entry: entry({ entryType: 'thread', externalChatId: 'oc_1', externalThreadId: 'thread_1' }) }), {
    replyMode: 'thread',
    target: 'thread',
    inThread: true,
    reason: 'thread_entry',
  });

  assert.deepEqual(resolveReplyMode({ entry: entry({ entryType: 'group', externalChatId: 'oc_1', externalThreadId: 'thread_1' }) }), {
    replyMode: 'thread',
    target: 'thread',
    inThread: true,
    reason: 'external_thread_ref',
  });

  assert.deepEqual(resolveReplyMode({ entry: entry({ entryType: 'group', metadata: { fake_im: { reply_to_message_id: ' parent-1 ' } } }) }), {
    replyMode: 'thread',
    target: 'thread',
    inThread: true,
    replyToMessageId: 'parent-1',
    reason: 'reply_to_message_ref',
  });
});

void test('reply mode resolver falls back web and unknown entries to direct dialog', () => {
  for (const entryType of ['web', 'unknown'] as EntryType[]) {
    assert.deepEqual(resolveReplyMode({ entry: entry({ entryType }) }), {
      replyMode: 'dialog',
      target: 'direct',
      inThread: false,
      reason: 'fallback_dialog',
    });
  }
});

void test('readReplyToMessageId safely reads fake IM and Feishu metadata only when string-like', () => {
  assert.equal(readReplyToMessageId({ fake_im: { reply_to_message_id: ' fake-parent ' } }), 'fake-parent');
  assert.equal(readReplyToMessageId({ feishu: { reply_to_message_id: 'feishu-parent' } }), 'feishu-parent');
  assert.equal(readReplyToMessageId({ fake_im: { reply_to_message_id: 123 }, feishu: { reply_to_message_id: 'feishu-parent' } }), 'feishu-parent');
  assert.equal(readReplyToMessageId({ fake_im: [], feishu: { reply_to_message_id: '' } }), undefined);
  assert.equal(readReplyToMessageId({ fake_im: null, feishu: 'bad' } as unknown as JsonRecord), undefined);
});
