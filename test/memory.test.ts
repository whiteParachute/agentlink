import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import { buildMemoryNaturalKey, normalizeBridgeStatus, normalizeMemoryText } from '../src/domain/memory.js';

void test('memory normalization trims text and locks bridge status to local', () => {
  assert.equal(normalizeMemoryText('  用户喜欢简洁回复  '), '用户喜欢简洁回复');
  assert.equal(normalizeBridgeStatus(undefined), 'local');
  assert.equal(normalizeBridgeStatus('local'), 'local');
});

void test('memory natural key is stable, bounded, and delimiter-safe', () => {
  const first = buildMemoryNaturalKey('user likes a:b/c? d');
  const replay = buildMemoryNaturalKey(' user likes a:b/c? d ');
  const different = buildMemoryNaturalKey('user likes another thing');
  assert.equal(first, replay);
  assert.notEqual(first, different);
  assert.match(first, /^memory:v1:[0-9a-f]{64}$/);
  assert.equal(first.includes('/'), false);
  assert.ok(first.length <= 1024);
});

void test('memory validation rejects invalid text/status fail-closed', () => {
  assert.throws(() => normalizeMemoryText('   '), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  assert.throws(() => normalizeMemoryText('x'.repeat(8193)), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  assert.throws(() => normalizeBridgeStatus('remote'), (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
});
