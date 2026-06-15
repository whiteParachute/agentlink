import { AgentlinkError } from '../control-plane/errors.js';
import type { EntryRecord, JsonRecord, SessionRecord, SessionScope } from './entities.js';
import { normalizePlatform } from './channel-user.js';
import { normalizeExternalRef } from './ingress.js';
import { readReplyToMessageId } from './reply-mode.js';

export const SESSION_SCOPES = ['large', 'small'] as const;

export interface SessionDraft {
  sessionScope: SessionScope;
  naturalKey: string;
  platform?: string;
  externalChatId?: string;
  externalThreadId?: string;
  parentSessionId?: string;
  groupProfileId?: string;
  displayName: string;
  metadata: JsonRecord;
}

export interface EntrySessionPlan {
  large: SessionDraft;
  small?: SessionDraft;
  targetScope: SessionScope;
}

export function normalizeSessionScope(value: string): SessionScope {
  const normalized = value.trim();
  if ((SESSION_SCOPES as readonly string[]).includes(normalized)) return normalized as SessionScope;
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'session_scope must be large or small');
}

export function normalizeSessionPlatform(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizePlatform(value);
}

export function normalizeSessionExternalRef(value: string | undefined, field: string): string | undefined {
  return normalizeExternalRef(value, field);
}

export function buildLargeSessionNaturalKey(kind: 'dm' | 'group' | 'fallback', platform: string | undefined, ref: string): string {
  const cleanRef = normalizeSessionExternalRef(ref, 'session_ref') ?? '';
  return [kind, platform ?? 'unknown', cleanRef].map(encodeSessionKeyComponent).join(':');
}

export function buildSmallThreadSessionNaturalKey(platform: string | undefined, chatId: string, threadId: string): string {
  const cleanChatId = normalizeSessionExternalRef(chatId, 'external_chat_id') ?? '';
  const cleanThreadId = normalizeSessionExternalRef(threadId, 'external_thread_id') ?? '';
  return ['thread', platform ?? 'unknown', cleanChatId, cleanThreadId].map(encodeSessionKeyComponent).join(':');
}

export function planSessionForEntry(entry: EntryRecord): EntrySessionPlan {
  const platform = normalizeSessionPlatform(entry.platform) ?? 'unknown';
  if (entry.entryType === 'dm') {
    const ref = firstString(entry.externalChatId, entry.speakerChannelUserId, entry.externalMessageId, entry.id);
    const externalChatId = normalizeSessionExternalRef(entry.externalChatId, 'external_chat_id');
    return {
      large: {
        sessionScope: 'large',
        naturalKey: buildLargeSessionNaturalKey('dm', platform, ref),
        platform,
        ...(externalChatId ? { externalChatId } : {}),
        displayName: 'DM Session',
        metadata: { entry_type: entry.entryType },
      },
      targetScope: 'large',
    };
  }

  if (isThreadLikeEntry(entry)) {
    const chatId = normalizeSessionExternalRef(entry.externalChatId, 'external_chat_id');
    if (!chatId) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'external_chat_id is required to resolve a thread session');
    const threadId = normalizeSessionExternalRef(entry.externalThreadId ?? readReplyToMessageId(entry.metadata), 'external_thread_id');
    if (!threadId) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'external_thread_id or reply_to_message_id is required to resolve a thread session');
    const large: SessionDraft = {
      sessionScope: 'large',
      naturalKey: buildLargeSessionNaturalKey('group', platform, chatId),
      platform,
      externalChatId: chatId,
      ...(entry.groupProfileId ? { groupProfileId: entry.groupProfileId } : {}),
      displayName: 'Group Session',
      metadata: { entry_type: entry.entryType },
    };
    const small: SessionDraft = {
      sessionScope: 'small',
      naturalKey: buildSmallThreadSessionNaturalKey(platform, chatId, threadId),
      platform,
      externalChatId: chatId,
      externalThreadId: threadId,
      ...(entry.groupProfileId ? { groupProfileId: entry.groupProfileId } : {}),
      displayName: 'Thread Session',
      metadata: { entry_type: entry.entryType, parent_kind: 'group' },
    };
    return { large, small, targetScope: 'small' };
  }

  if (entry.entryType === 'group') {
    const chatId = normalizeSessionExternalRef(entry.externalChatId, 'external_chat_id');
    if (!chatId) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'external_chat_id is required to resolve a group session');
    return {
      large: {
        sessionScope: 'large',
        naturalKey: buildLargeSessionNaturalKey('group', platform, chatId),
        platform,
        externalChatId: chatId,
        ...(entry.groupProfileId ? { groupProfileId: entry.groupProfileId } : {}),
        displayName: 'Group Session',
        metadata: { entry_type: entry.entryType },
      },
      targetScope: 'large',
    };
  }

  const fallbackRef = firstString(entry.externalChatId, entry.externalMessageId, entry.sourceEventId, entry.id);
  const externalChatId = normalizeSessionExternalRef(entry.externalChatId, 'external_chat_id');
  return {
    large: {
      sessionScope: 'large',
      naturalKey: buildLargeSessionNaturalKey('fallback', platform, fallbackRef),
      platform,
      ...(externalChatId ? { externalChatId } : {}),
      displayName: 'Session',
      metadata: { entry_type: entry.entryType },
    },
    targetScope: 'large',
  };
}

export function sessionMatchesDraft(session: SessionRecord, draft: SessionDraft): boolean {
  return session.sessionScope === draft.sessionScope && session.naturalKey === draft.naturalKey;
}

function isThreadLikeEntry(entry: EntryRecord): boolean {
  return entry.entryType === 'thread' || hasStringValue(entry.externalThreadId) || readReplyToMessageId(entry.metadata) !== undefined;
}

function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (hasStringValue(value)) return value.trim();
  }
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'session reference must be derivable from entry refs');
}

function hasStringValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function encodeSessionKeyComponent(value: string): string {
  return encodeURIComponent(value);
}
