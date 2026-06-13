import { AgentlinkError } from '../control-plane/errors.js';

export const DEFAULT_USER_CATEGORY = 'unclassified';
export const USER_CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const PLATFORM_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
export const MAX_EXTERNAL_ID_LENGTH = 512;

export function normalizePlatform(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PLATFORM_PATTERN.test(normalized)) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'platform must match ^[a-z][a-z0-9._:-]{0,63}$');
  }
  return normalized;
}

export function normalizeExternalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_EXTERNAL_ID_LENGTH) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'external_id must be non-empty and <= 512 characters');
  }
  return normalized;
}

export function normalizeUserCategory(value: string): string {
  const normalized = value.trim();
  if (!USER_CATEGORY_PATTERN.test(normalized)) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'category must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$');
  }
  return normalized;
}
