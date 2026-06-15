import { createHash } from 'node:crypto';
import { AgentlinkError } from '../control-plane/errors.js';

export type MemoryBridgeStatus = 'local';

export function normalizeMemoryText(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'memory_text must be a non-empty string');
  if (normalized.length > 8192) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'memory_text must be at most 8192 characters');
  return normalized;
}

export function buildMemoryNaturalKey(memoryText: string): string {
  const normalizedText = normalizeMemoryText(memoryText);
  const digest = createHash('sha256').update(normalizedText, 'utf8').digest('hex');
  return ['memory', 'v1', digest].map(encodeMemoryKeyComponent).join(':');
}

export function normalizeBridgeStatus(value: string | undefined): MemoryBridgeStatus {
  if (value === undefined || value.trim() === 'local') return 'local';
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'bridge_status must be local');
}

function encodeMemoryKeyComponent(value: string): string {
  return encodeURIComponent(value);
}
