import type { EntryRecord, GroupProfileRecord, JsonRecord, ReplyMode } from './entities.js';

export type ReplyTarget = 'direct' | 'thread' | 'channel';

export interface ReplyModeResolution {
  replyMode: ReplyMode;
  target: ReplyTarget;
  inThread: boolean;
  replyToMessageId?: string;
  reason: string;
}

export interface ResolveReplyModeInput {
  entry: EntryRecord;
  groupProfile?: GroupProfileRecord;
}

export function resolveReplyMode(input: ResolveReplyModeInput): ReplyModeResolution {
  const { entry, groupProfile } = input;
  const replyToMessageId = readReplyToMessageId(entry.metadata);

  if (entry.entryType === 'dm') {
    return withOptionalReplyTo(entry, {
      replyMode: 'dialog',
      target: 'direct',
      inThread: false,
      reason: reasonWithMention(entry, 'dm_entry_dialog'),
    });
  }

  if (entry.entryType === 'thread' || hasStringValue(entry.externalThreadId) || replyToMessageId !== undefined) {
    return {
      replyMode: 'thread',
      target: 'thread',
      inThread: true,
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
      reason: reasonWithMention(entry, threadReason(entry, replyToMessageId)),
    };
  }

  if (entry.entryType === 'group') {
    const replyMode = groupProfile?.defaultReplyMode ?? 'thread';
    return {
      replyMode,
      target: replyMode === 'dialog' ? 'channel' : 'thread',
      inThread: false,
      reason: reasonWithMention(entry, groupProfile === undefined ? 'group_default_thread' : `group_profile_${replyMode}`),
    };
  }

  return withOptionalReplyTo(entry, {
    replyMode: 'dialog',
    target: 'direct',
    inThread: false,
    reason: reasonWithMention(entry, 'fallback_dialog'),
  });
}

export function readReplyToMessageId(metadata: JsonRecord): string | undefined {
  return readNestedString(metadata, 'fake_im', 'reply_to_message_id') ?? readNestedString(metadata, 'feishu', 'reply_to_message_id');
}

function readNestedString(metadata: JsonRecord, namespace: string, field: string): string | undefined {
  const section = metadata[namespace];
  if (!isJsonRecord(section)) return undefined;
  const value = section[field];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function threadReason(entry: EntryRecord, replyToMessageId: string | undefined): string {
  if (entry.entryType === 'thread') return 'thread_entry';
  if (hasStringValue(entry.externalThreadId)) return 'external_thread_ref';
  if (replyToMessageId !== undefined) return 'reply_to_message_ref';
  return 'thread_signal';
}

function withOptionalReplyTo(entry: EntryRecord, resolution: ReplyModeResolution): ReplyModeResolution {
  const replyToMessageId = readReplyToMessageId(entry.metadata);
  return replyToMessageId === undefined ? resolution : { ...resolution, replyToMessageId };
}

function reasonWithMention(entry: EntryRecord, reason: string): string {
  return entry.agentMentioned ? `${reason};agent_mentioned` : reason;
}

function hasStringValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
