import { AgentlinkError } from '../control-plane/errors.js';
import type { EntryRecord, GroupProfileRecord, JsonRecord, SessionRecord } from './entities.js';
import { resolveReplyMode, type ReplyModeResolution } from './reply-mode.js';

export const MAIN_AGENT_SOURCE = 'main-agent';
export const MAIN_AGENT_ROUTE_IDEMPOTENCY_PREFIX = 'entry-route:';

export interface MainAgentRouteTaskDraft {
  idempotencyKey: string;
  taskInput: {
    source: typeof MAIN_AGENT_SOURCE;
    sourceRef: string;
    payload: JsonRecord;
    taskSpec: JsonRecord;
    maxRetries: number;
  };
}

export interface BuildMainAgentRouteTaskInput {
  entry: EntryRecord;
  session: SessionRecord;
  groupProfile?: GroupProfileRecord;
}

export function buildEntryRouteIdempotencyKey(entryId: string): string {
  const normalized = normalizeEntryId(entryId);
  return `${MAIN_AGENT_ROUTE_IDEMPOTENCY_PREFIX}${normalized}`;
}

export function buildMainAgentRouteTask(input: BuildMainAgentRouteTaskInput): MainAgentRouteTaskDraft {
  const { entry, session, groupProfile } = input;
  if (!entry.sessionId) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'Entry must be resolved to a session before routing');
  if (entry.sessionId !== session.id) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'Entry session_id does not match the resolved session');
  const resolution = resolveReplyMode({ entry, ...(groupProfile ? { groupProfile } : {}) });
  const replyMode = toReplyModePayload(resolution);
  const payload: JsonRecord = {
    entry_id: entry.id,
    session_id: session.id,
    source_event_id: entry.sourceEventId,
    reply_mode: replyMode,
    memory_candidate_ids: [],
    memory_ids: [],
  };
  const taskSpec: JsonRecord = {
    type: 'main_agent_entry_route',
    intent: 'route_entry_to_main_agent',
    source: MAIN_AGENT_SOURCE,
    input: {
      entry_id: entry.id,
      session_id: session.id,
      source_event_id: entry.sourceEventId,
    },
    reply_mode: replyMode,
    required_capabilities: ['codex:exec'],
    route: {
      runner: 'codex',
      device: 'claw-tenc',
    },
    network_scope: 'personal',
    workdir_access: 'read_write',
  };
  assertNoRawMessageContent(payload);
  assertNoRawMessageContent(taskSpec);
  return {
    idempotencyKey: buildEntryRouteIdempotencyKey(entry.id),
    taskInput: {
      source: MAIN_AGENT_SOURCE,
      sourceRef: entry.id,
      payload,
      taskSpec,
      maxRetries: 1,
    },
  };
}

export function toReplyModePayload(resolution: ReplyModeResolution): JsonRecord {
  return {
    reply_mode: resolution.replyMode,
    target: resolution.target,
    in_thread: resolution.inThread,
    ...(resolution.replyToMessageId !== undefined ? { reply_to_message_id: resolution.replyToMessageId } : {}),
    reason: resolution.reason,
  };
}

export function assertNoRawMessageContent(value: unknown): void {
  const forbiddenKeys = new Set(['bodyText', 'body_text', 'text', 'raw_message', 'full_transcript', 'source_payload', 'source_event_payload']);
  visitJson(value, (key) => {
    if (forbiddenKeys.has(key)) {
      throw new AgentlinkError(500, 'AL_INTERNAL', `Main agent route task must not contain raw message field ${key}`);
    }
  });
}

function normalizeEntryId(entryId: string): string {
  const normalized = entryId.trim();
  if (normalized.length === 0) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'entry_id must be a non-empty string');
  return normalized;
}

function visitJson(value: unknown, onKey: (key: string) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, onKey);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    onKey(key);
    visitJson(child, onKey);
  }
}
