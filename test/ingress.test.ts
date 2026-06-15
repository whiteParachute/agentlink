import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import {
  normalizeBodyText,
  normalizeEntryType,
  normalizeEventType,
  normalizeExternalRef,
  normalizeIngressPlatform,
  normalizeOccurredAt,
  normalizeSourceRef,
  normalizeSourceSystem,
} from '../src/domain/ingress.js';

void test('ingress normalization preserves refs and normalizes source/platform', () => {
  assert.equal(normalizeSourceSystem(' FeiShu.Bot '), 'feishu.bot');
  assert.equal(normalizeSourceRef(' Msg-ABC '), 'Msg-ABC');
  assert.equal(normalizeEventType('message.receive_v1'), 'message.receive_v1');
  assert.equal(normalizeEntryType('group'), 'group');
  assert.equal(normalizeEntryType(undefined), 'unknown');
  assert.equal(normalizeIngressPlatform(' FeiShu '), 'feishu');
  assert.equal(normalizeExternalRef(' oc_1 ', 'external_chat_id'), 'oc_1');
  assert.equal(normalizeBodyText(' hello '), ' hello ');
  assert.equal(normalizeOccurredAt('2026-06-15T00:00:00.000Z', 'fallback'), '2026-06-15T00:00:00.000Z');
  assert.equal(normalizeOccurredAt(undefined, 'fallback'), 'fallback');
});

void test('ingress normalization rejects invalid inputs with AL_BAD_REQUEST', () => {
  const cases: Array<() => unknown> = [
    () => normalizeSourceSystem('Bad Source'),
    () => normalizeSourceRef(''),
    () => normalizeSourceRef('a'.repeat(513)),
    () => normalizeEventType('-bad'),
    () => normalizeEntryType('session'),
    () => normalizeIngressPlatform('1bad'),
    () => normalizeExternalRef('', 'external_chat_id'),
    () => normalizeBodyText('x'.repeat(100_001)),
    () => normalizeOccurredAt('not-a-date', 'fallback'),
  ];
  for (const fn of cases) {
    assert.throws(fn, (error) => error instanceof AgentlinkError && error.code === 'AL_BAD_REQUEST');
  }
});
