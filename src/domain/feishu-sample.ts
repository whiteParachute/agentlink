import { AgentlinkError } from '../control-plane/errors.js';
import type { EntryType, JsonRecord } from './entities.js';
import { normalizeBodyText, normalizeExternalRef, normalizeOccurredAt } from './ingress.js';

export const FEISHU_SAMPLE_SOURCE_SYSTEM = 'feishu';
export const FEISHU_SAMPLE_PLATFORM = 'feishu';
export const FEISHU_SAMPLE_EVENT_TYPE = 'im.message.receive_v1';
export const FEISHU_SAMPLE_ADAPTER = 'feishu-sample';

type FeishuChatType = 'p2p' | 'group';

export interface NormalizedFeishuSampleEvent {
  kind: Extract<EntryType, 'dm' | 'group' | 'thread'>;
  messageId: string;
  chatId: string;
  chatType: FeishuChatType;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  messageType: 'text';
  text: string;
  senderId: string;
  senderIdType: string;
  mentions: JsonRecord[];
  agentMentioned: boolean;
  occurredAt?: string;
  metadata: JsonRecord;
  rawEvent: JsonRecord;
}

export interface FeishuSampleIngestInput {
  sourceSystem: typeof FEISHU_SAMPLE_SOURCE_SYSTEM;
  sourceRef: string;
  eventType: typeof FEISHU_SAMPLE_EVENT_TYPE;
  platform: typeof FEISHU_SAMPLE_PLATFORM;
  occurredAt?: string;
  payload: JsonRecord;
  metadata: JsonRecord;
  entryType: EntryType;
  externalChatId: string;
  externalThreadId?: string;
  externalMessageId: string;
  agentMentioned: boolean;
  bodyText: string;
  entryMetadata: JsonRecord;
}

export function normalizeFeishuSampleEvent(input: JsonRecord): NormalizedFeishuSampleEvent {
  const header = readRequiredRecord(input, 'header');
  const eventType = readRequiredString(header, 'event_type');
  if (eventType !== FEISHU_SAMPLE_EVENT_TYPE) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', `header.event_type must be ${FEISHU_SAMPLE_EVENT_TYPE}`);
  }

  const event = readRequiredRecord(input, 'event');
  const message = readRequiredRecord(event, 'message');
  const sender = readRequiredRecord(event, 'sender');
  const senderIdRecord = readRequiredRecord(sender, 'sender_id');

  const messageId = requireExternalRef(readRequiredString(message, 'message_id'), 'message_id');
  const chatId = requireExternalRef(readRequiredString(message, 'chat_id'), 'chat_id');
  const chatType = normalizeChatType(readRequiredString(message, 'chat_type'));
  const messageType = readRequiredString(message, 'message_type');
  if (messageType !== 'text') {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'message.message_type must be text for AL-M1-008 Feishu sample PoC');
  }

  const rootId = normalizeBlankOptionalRef(readOptionalString(message, 'root_id'), 'root_id');
  const parentId = normalizeBlankOptionalRef(readOptionalString(message, 'parent_id'), 'parent_id');
  if (parentId !== undefined && rootId === undefined) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'message.root_id is required for threaded Feishu replies with parent_id');
  }

  const content = parseTextContent(readRequiredString(message, 'content'));
  const mentions = readOptionalMentions(message);
  const agentMentioned = mentions.length > 0 || content.text.includes('<at ');
  const metadata = readOptionalRecord(input, 'metadata') ?? {};
  const occurredAt = normalizeFeishuCreateTime(readOptionalString(header, 'create_time') ?? readOptionalString(message, 'create_time'));
  const senderInfo = pickSenderId(senderIdRecord);
  const kind = rootId !== undefined || parentId !== undefined ? 'thread' : chatType === 'p2p' ? 'dm' : 'group';

  return {
    kind,
    messageId,
    chatId,
    chatType,
    ...(rootId !== undefined ? { rootId, threadId: rootId } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    messageType: 'text',
    text: normalizeBodyText(content.text),
    senderId: senderInfo.senderId,
    senderIdType: senderInfo.senderIdType,
    mentions,
    agentMentioned,
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    metadata,
    rawEvent: input,
  };
}

export function buildFeishuSampleSourceRef(event: NormalizedFeishuSampleEvent): string {
  const threadRef = event.kind === 'thread' ? event.threadId ?? 'missing-thread' : 'none';
  return [FEISHU_SAMPLE_SOURCE_SYSTEM, event.kind, event.chatId, threadRef, event.messageId].map(encodeSourceRefComponent).join(':');
}

export function mapFeishuSampleEventToIngest(event: NormalizedFeishuSampleEvent): FeishuSampleIngestInput {
  const feishuEvent = toFeishuSampleEventDto(event);
  const adapterMetadata = buildAdapterMetadata(event);
  return {
    sourceSystem: FEISHU_SAMPLE_SOURCE_SYSTEM,
    sourceRef: buildFeishuSampleSourceRef(event),
    eventType: FEISHU_SAMPLE_EVENT_TYPE,
    platform: FEISHU_SAMPLE_PLATFORM,
    ...(event.occurredAt !== undefined ? { occurredAt: event.occurredAt } : {}),
    payload: { feishu_event: event.rawEvent },
    metadata: { ...event.metadata, feishu: adapterMetadata },
    entryType: event.kind,
    externalChatId: event.chatId,
    ...(event.threadId !== undefined ? { externalThreadId: event.threadId } : {}),
    externalMessageId: event.messageId,
    agentMentioned: event.agentMentioned,
    bodyText: event.text,
    entryMetadata: { feishu: adapterMetadata, feishu_event: feishuEvent },
  };
}

export function toFeishuSampleEventDto(event: NormalizedFeishuSampleEvent): JsonRecord {
  return {
    kind: event.kind,
    message_id: event.messageId,
    chat_id: event.chatId,
    chat_type: event.chatType,
    ...(event.rootId !== undefined ? { root_id: event.rootId } : {}),
    ...(event.parentId !== undefined ? { parent_id: event.parentId } : {}),
    ...(event.threadId !== undefined ? { thread_id: event.threadId } : {}),
    message_type: event.messageType,
    text: event.text,
    sender_id: event.senderId,
    sender_id_type: event.senderIdType,
    ...(event.mentions.length > 0 ? { mentions: event.mentions } : {}),
    agent_mentioned: event.agentMentioned,
    ...(event.occurredAt !== undefined ? { occurred_at: event.occurredAt } : {}),
    metadata: event.metadata,
    source_ref: buildFeishuSampleSourceRef(event),
  };
}

function buildAdapterMetadata(event: NormalizedFeishuSampleEvent): JsonRecord {
  return {
    adapter: FEISHU_SAMPLE_ADAPTER,
    kind: event.kind,
    chat_type: event.chatType,
    message_type: event.messageType,
    ...(event.rootId !== undefined ? { root_id: event.rootId } : {}),
    ...(event.parentId !== undefined ? { parent_id: event.parentId, reply_to_message_id: event.parentId } : {}),
    sender_id: event.senderId,
    sender_id_type: event.senderIdType,
    ...(event.mentions.length > 0 ? { mentions: event.mentions } : {}),
  };
}

function normalizeChatType(value: string): FeishuChatType {
  if (value === 'p2p' || value === 'group') return value;
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'message.chat_type must be p2p or group');
}

function parseTextContent(rawContent: string): { text: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent) as unknown;
  } catch {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'message.content must be valid JSON');
  }
  if (!isJsonRecord(parsed)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'message.content must decode to an object');
  const text = parsed.text;
  if (typeof text !== 'string') throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'message.content.text must be a string');
  return { text };
}

function normalizeFeishuCreateTime(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = new Date(Number(trimmed));
    if (Number.isNaN(parsed.getTime())) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'header.create_time must be a valid timestamp');
    return parsed.toISOString();
  }
  try {
    return normalizeOccurredAt(trimmed, trimmed);
  } catch {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'header.create_time must be a valid timestamp');
  }
}

function readRequiredRecord(input: JsonRecord, key: string): JsonRecord {
  const value = input[key];
  if (!isJsonRecord(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an object`);
  return value;
}

function readOptionalRecord(input: JsonRecord, key: string): JsonRecord | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be an object`);
  return value;
}

function readRequiredString(input: JsonRecord, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a non-empty string`);
  return value;
}

function readOptionalString(input: JsonRecord, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${key} must be a string`);
  return value;
}

function requireExternalRef(value: string, field: string): string {
  return normalizeExternalRef(value, field) ?? failBadRequest(`${field} must be a non-empty string`);
}

function normalizeBlankOptionalRef(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return normalizeExternalRef(value, field);
}

function readOptionalMentions(message: JsonRecord): JsonRecord[] {
  const value = message.mentions;
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isJsonRecord)) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'message.mentions must be an array of objects');
  return value;
}

function pickSenderId(senderIdRecord: JsonRecord): { senderId: string; senderIdType: string } {
  const candidates: Array<[string, unknown]> = [
    ['open_id', senderIdRecord.open_id],
    ['user_id', senderIdRecord.user_id],
    ['union_id', senderIdRecord.union_id],
  ];
  for (const [key, value] of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return { senderId: value.trim(), senderIdType: key };
  }
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'event.sender.sender_id must include open_id, user_id, or union_id');
}

function failBadRequest(message: string): never {
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', message);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeSourceRefComponent(value: string): string {
  return encodeURIComponent(value);
}
