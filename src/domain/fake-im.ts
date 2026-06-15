import { AgentlinkError } from '../control-plane/errors.js';
import type { EntryType, JsonRecord } from './entities.js';
import { normalizeBodyText, normalizeExternalRef, normalizeOccurredAt } from './ingress.js';

export const FAKE_IM_SOURCE_SYSTEM = 'fake-im';
export const FAKE_IM_EVENT_TYPE = 'message.receive';
export const FAKE_IM_KINDS = ['dm', 'group', 'thread'] as const;

export type FakeImKind = (typeof FAKE_IM_KINDS)[number];

export interface NormalizedFakeImEvent {
  kind: FakeImKind;
  messageId: string;
  chatId?: string;
  threadId?: string;
  replyToMessageId?: string;
  text: string;
  speakerChannelUserId?: string;
  groupProfileId?: string;
  agentMentioned: boolean;
  occurredAt?: string;
  metadata: JsonRecord;
}

export interface FakeImIngestInput {
  sourceSystem: typeof FAKE_IM_SOURCE_SYSTEM;
  sourceRef: string;
  eventType: typeof FAKE_IM_EVENT_TYPE;
  platform: typeof FAKE_IM_SOURCE_SYSTEM;
  occurredAt?: string;
  payload: JsonRecord;
  metadata: JsonRecord;
  entryType: EntryType;
  externalChatId?: string;
  externalThreadId?: string;
  externalMessageId: string;
  speakerChannelUserId?: string;
  groupProfileId?: string;
  agentMentioned: boolean;
  bodyText: string;
  entryMetadata: JsonRecord;
}

export function normalizeFakeImEvent(input: JsonRecord): NormalizedFakeImEvent {
  const kind = normalizeFakeImKind(readRequiredAliasString(input, 'kind', 'kind'));
  const messageId = normalizeExternalRef(readRequiredAliasString(input, 'messageId', 'message_id'), 'message_id') ?? '';
  const chatId = normalizeExternalRef(readOptionalAliasString(input, 'chatId', 'chat_id'), 'chat_id');
  const threadId = normalizeExternalRef(readOptionalAliasString(input, 'threadId', 'thread_id'), 'thread_id');
  const replyToMessageId = normalizeExternalRef(readOptionalAliasString(input, 'replyToMessageId', 'reply_to_message_id'), 'reply_to_message_id');
  const text = normalizeBodyText(readOptionalAliasString(input, 'text', 'text'));
  const speakerChannelUserId = normalizeExternalRef(readOptionalAliasString(input, 'speakerChannelUserId', 'speaker_channel_user_id'), 'speaker_channel_user_id');
  const groupProfileId = normalizeExternalRef(readOptionalAliasString(input, 'groupProfileId', 'group_profile_id'), 'group_profile_id');
  const agentMentioned = readOptionalAliasBoolean(input, 'agentMentioned', 'agent_mentioned') ?? false;
  const rawOccurredAt = readOptionalAliasString(input, 'occurredAt', 'occurred_at');
  const occurredAt = rawOccurredAt === undefined ? undefined : normalizeOccurredAt(rawOccurredAt, rawOccurredAt);
  const metadata = readOptionalRecord(input, 'metadata') ?? {};

  if ((kind === 'group' || kind === 'thread') && chatId === undefined) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'chat_id is required for group and thread fake IM events');
  }
  if (kind === 'thread' && threadId === undefined) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'thread_id is required for thread fake IM events');
  }

  return {
    kind,
    messageId,
    ...(chatId !== undefined ? { chatId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    text,
    ...(speakerChannelUserId !== undefined ? { speakerChannelUserId } : {}),
    ...(groupProfileId !== undefined ? { groupProfileId } : {}),
    agentMentioned,
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    metadata,
  };
}

export function buildFakeImSourceRef(event: NormalizedFakeImEvent): string {
  const chatRef = event.kind === 'dm' ? event.chatId ?? 'dm' : event.chatId ?? 'missing-chat';
  const threadRef = event.kind === 'thread' ? event.threadId ?? 'missing-thread' : 'none';
  return [FAKE_IM_SOURCE_SYSTEM, event.kind, chatRef, threadRef, event.messageId].map(encodeSourceRefComponent).join(':');
}

export function mapFakeImEventToIngest(event: NormalizedFakeImEvent): FakeImIngestInput {
  const fakeImPayload = toFakeImEventDto(event);
  const adapterMetadata = {
    adapter: FAKE_IM_SOURCE_SYSTEM,
    kind: event.kind,
    ...(event.replyToMessageId !== undefined ? { reply_to_message_id: event.replyToMessageId } : {}),
  };
  return {
    sourceSystem: FAKE_IM_SOURCE_SYSTEM,
    sourceRef: buildFakeImSourceRef(event),
    eventType: FAKE_IM_EVENT_TYPE,
    platform: FAKE_IM_SOURCE_SYSTEM,
    ...(event.occurredAt !== undefined ? { occurredAt: event.occurredAt } : {}),
    payload: { fake_im_event: fakeImPayload },
    metadata: { ...event.metadata, fake_im: adapterMetadata },
    entryType: event.kind,
    ...(event.chatId !== undefined ? { externalChatId: event.chatId } : {}),
    ...(event.threadId !== undefined ? { externalThreadId: event.threadId } : {}),
    externalMessageId: event.messageId,
    ...(event.speakerChannelUserId !== undefined ? { speakerChannelUserId: event.speakerChannelUserId } : {}),
    ...(event.groupProfileId !== undefined ? { groupProfileId: event.groupProfileId } : {}),
    agentMentioned: event.agentMentioned,
    bodyText: event.text,
    entryMetadata: { fake_im: adapterMetadata },
  };
}

export function toFakeImEventDto(event: NormalizedFakeImEvent): JsonRecord {
  return {
    kind: event.kind,
    message_id: event.messageId,
    ...(event.chatId !== undefined ? { chat_id: event.chatId } : {}),
    ...(event.threadId !== undefined ? { thread_id: event.threadId } : {}),
    ...(event.replyToMessageId !== undefined ? { reply_to_message_id: event.replyToMessageId } : {}),
    text: event.text,
    ...(event.speakerChannelUserId !== undefined ? { speaker_channel_user_id: event.speakerChannelUserId } : {}),
    ...(event.groupProfileId !== undefined ? { group_profile_id: event.groupProfileId } : {}),
    agent_mentioned: event.agentMentioned,
    ...(event.occurredAt !== undefined ? { occurred_at: event.occurredAt } : {}),
    metadata: event.metadata,
    source_ref: buildFakeImSourceRef(event),
  };
}

function normalizeFakeImKind(value: string): FakeImKind {
  const normalized = value.trim();
  if ((FAKE_IM_KINDS as readonly string[]).includes(normalized)) return normalized as FakeImKind;
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'kind must be dm, group, or thread');
}

function readRequiredAliasString(input: JsonRecord, camelKey: string, snakeKey: string): string {
  const value = readOptionalAliasString(input, camelKey, snakeKey);
  if (value === undefined || value.length === 0) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${snakeKey} must be a non-empty string`);
  return value;
}

function readOptionalAliasString(input: JsonRecord, camelKey: string, snakeKey: string): string | undefined {
  const value = readAlias(input, camelKey, snakeKey);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${snakeKey} must be a string`);
  return value;
}

function readOptionalAliasBoolean(input: JsonRecord, camelKey: string, snakeKey: string): boolean | undefined {
  const value = readAlias(input, camelKey, snakeKey);
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${snakeKey} must be a boolean`);
  return value;
}

function readAlias(input: JsonRecord, camelKey: string, snakeKey: string): unknown {
  const camelValue = input[camelKey];
  const snakeValue = input[snakeKey];
  if (camelValue !== undefined && snakeValue !== undefined && camelValue !== snakeValue) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${snakeKey} aliases must not conflict`);
  }
  return snakeValue ?? camelValue;
}

function readOptionalRecord(input: JsonRecord, key: string): JsonRecord | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an object`);
  return value;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeSourceRefComponent(value: string): string {
  return encodeURIComponent(value);
}
