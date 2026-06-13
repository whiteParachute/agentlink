import { AgentlinkError } from '../control-plane/errors.js';
import { normalizePlatform } from './channel-user.js';

export const DEFAULT_GROUP_TYPE = 'general';
export const DEFAULT_GROUP_TONE = 'neutral';
export const DEFAULT_REPLY_MODE = 'thread';
export const DEFAULT_CONTEXT_SCOPE = 'group';
export const DEFAULT_MEMORY_SCOPE = 'group';

export const GROUP_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const GROUP_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MAX_EXTERNAL_GROUP_ID_LENGTH = 512;

export function normalizeGroupPlatform(value: string): string {
  return normalizePlatform(value);
}

export function normalizeExternalGroupId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_EXTERNAL_GROUP_ID_LENGTH) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'external_group_id must be non-empty and <= 512 characters');
  }
  return normalized;
}

export function normalizeReplyMode(value: string): 'thread' | 'dialog' {
  if (value === 'thread' || value === 'dialog') return value;
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'default_reply_mode must be thread or dialog');
}

export function normalizeGroupToken(value: string, field: 'group_type' | 'tone'): string {
  const normalized = value.trim();
  if (!GROUP_TOKEN_PATTERN.test(normalized)) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${field} must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`);
  }
  return normalized;
}

export function normalizeGroupScope(value: string, field: 'context_scope' | 'memory_scope'): string {
  const normalized = value.trim();
  if (!GROUP_SCOPE_PATTERN.test(normalized)) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${field} must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`);
  }
  return normalized;
}
