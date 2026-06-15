import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import {
  buildCandidateNaturalKey,
  normalizeCandidateReason,
  normalizeCandidateStatus,
  normalizeCandidateText,
  normalizeConfidence,
} from '../src/domain/memory-candidate.js';

void test('memory candidate normalization trims text/status/reason and confidence', () => {
  assert.equal(normalizeCandidateText('  remember user prefers concise replies  '), 'remember user prefers concise replies');
  assert.equal(normalizeCandidateStatus(' Accepted '), 'accepted');
  assert.equal(normalizeCandidateReason('  user approved  '), 'user approved');
  assert.equal(normalizeCandidateReason(undefined), '');
  assert.equal(normalizeConfidence(0.9876), 0.988);
  assert.equal(normalizeConfidence(undefined), undefined);
});

void test('memory candidate natural key is stable, bounded, and delimiter-safe', () => {
  const first = buildCandidateNaturalKey('user likes a:b/c? d');
  const replay = buildCandidateNaturalKey(' user likes a:b/c? d ');
  const different = buildCandidateNaturalKey('user likes another thing');
  assert.equal(first, replay);
  assert.notEqual(first, different);
  assert.match(first, /^candidate:v1:[0-9a-f]{64}$/);
  assert.equal(first.includes('/'), false);
  assert.ok(first.length <= 1024);
});

void test('memory candidate validation rejects invalid status/text/confidence fail-closed', () => {
  assert.throws(() => normalizeCandidateText('   '), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  assert.throws(() => normalizeCandidateText('x'.repeat(8193)), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  assert.throws(() => normalizeCandidateStatus('done'), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  assert.throws(() => normalizeConfidence(-0.1), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  assert.throws(() => normalizeConfidence(1.1), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
});
