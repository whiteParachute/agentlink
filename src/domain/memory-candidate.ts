import { createHash } from 'node:crypto';
import { AgentlinkError } from '../control-plane/errors.js';
import type { MemoryCandidateStatus } from './entities.js';

export const MEMORY_CANDIDATE_STATUSES = ['pending', 'accepted', 'rejected'] as const;

export function normalizeCandidateStatus(value: string): MemoryCandidateStatus {
  const normalized = value.trim().toLowerCase();
  if ((MEMORY_CANDIDATE_STATUSES as readonly string[]).includes(normalized)) return normalized as MemoryCandidateStatus;
  throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'status must be pending, accepted, or rejected');
}

export function normalizeCandidateText(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'candidate_text must be a non-empty string');
  if (normalized.length > 8192) throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'candidate_text must be at most 8192 characters');
  return normalized;
}

export function normalizeCandidateReason(value: string | undefined): string {
  if (value === undefined) return '';
  return value.trim();
}

export function normalizeConfidence(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AgentlinkError(400, 'AL_BAD_REQUEST', 'confidence must be a finite number between 0 and 1');
  }
  return Math.round(value * 1000) / 1000;
}

export function buildCandidateNaturalKey(candidateText: string): string {
  const normalizedText = normalizeCandidateText(candidateText);
  const digest = createHash('sha256').update(normalizedText, 'utf8').digest('hex');
  return ['candidate', 'v1', digest].map(encodeCandidateKeyComponent).join(':');
}

function encodeCandidateKeyComponent(value: string): string {
  return encodeURIComponent(value);
}
