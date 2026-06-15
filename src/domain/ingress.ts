import { AgentlinkError } from '../control-plane/errors.js';
import type { EntryType } from './entities.js';
import { normalizePlatform } from './channel-user.js';

export const ENTRY_TYPES = ['dm', 'group', 'thread', 'web', 'unknown'] as const;
export const DEFAULT_ENTRY_TYPE: EntryType = 'unknown';
export const SOURCE_SYSTEM_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
export const INGRESS_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MAX_SOURCE_REF_LENGTH = 512;
export const MAX_BODY_TEXT_LENGTH = 100_000;

export function normalizeSourceSystem(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SOURCE_SYSTEM_PATTERN.test(normalized)) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'source_system must match ^[a-z][a-z0-9._:-]{0,63}$');
  }
  return normalized;
}

export function normalizeSourceRef(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_SOURCE_REF_LENGTH) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'source_ref must be non-empty and <= 512 characters');
  }
  return normalized;
}

export function normalizeEventType(value: string): string {
  const normalized = value.trim();
  if (!INGRESS_TOKEN_PATTERN.test(normalized)) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'event_type must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  }
  return normalized;
}

export function normalizeEntryType(value: string | undefined): EntryType {
  if (value === undefined || value.trim() === '') return DEFAULT_ENTRY_TYPE;
  const normalized = value.trim();
  if ((ENTRY_TYPES as readonly string[]).includes(normalized)) return normalized as EntryType;
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'entry_type must be dm, group, thread, web, or unknown');
}

export function normalizeIngressPlatform(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizePlatform(value);
}

export function normalizeExternalRef(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_SOURCE_REF_LENGTH) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', `${field} must be non-empty and <= 512 characters`);
  }
  return normalized;
}

export function normalizeBodyText(value: string | undefined): string {
  if (value === undefined) return '';
  if (value.length > MAX_BODY_TEXT_LENGTH) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', `body_text must be <= ${MAX_BODY_TEXT_LENGTH} characters`);
  }
  return value;
}

export function normalizeOccurredAt(value: string | undefined, fallbackIso: string): string {
  if (value === undefined) return fallbackIso;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'occurred_at must be a valid timestamp');
  }
  return parsed.toISOString();
}
