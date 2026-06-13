import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import {
  DEFAULT_USER_CATEGORY,
  normalizeExternalId,
  normalizePlatform,
  normalizeUserCategory,
} from '../src/domain/channel-user.js';

test('channel user defaults and normalization follow AL-M1-004 rules', () => {
  assert.equal(DEFAULT_USER_CATEGORY, 'unclassified');
  assert.equal(normalizePlatform(' Feishu.Open_ID '), 'feishu.open_id');
  assert.equal(normalizeExternalId(' User-ABC '), 'User-ABC');
  assert.equal(normalizeUserCategory(' Family.Child '), 'Family.Child');
});

test('normalizeExternalId trims but does not lowercase', () => {
  assert.equal(normalizeExternalId('  MixedCase-ID  '), 'MixedCase-ID');
});

test('channel user normalization rejects invalid platform/category/external_id', () => {
  assert.throws(
    () => normalizePlatform('9bad'),
    (error) => error instanceof AgentlinkError && error.statusCode === 400 && error.code === 'AL_BAD_REQUEST',
  );
  assert.throws(
    () => normalizePlatform('has space'),
    (error) => error instanceof AgentlinkError && error.statusCode === 400 && error.code === 'AL_BAD_REQUEST',
  );
  assert.throws(
    () => normalizeExternalId('   '),
    (error) => error instanceof AgentlinkError && error.statusCode === 400 && error.code === 'AL_BAD_REQUEST',
  );
  assert.throws(
    () => normalizeExternalId('x'.repeat(513)),
    (error) => error instanceof AgentlinkError && error.statusCode === 400 && error.code === 'AL_BAD_REQUEST',
  );
  assert.throws(
    () => normalizeUserCategory('-bad'),
    (error) => error instanceof AgentlinkError && error.statusCode === 400 && error.code === 'AL_BAD_REQUEST',
  );
});
