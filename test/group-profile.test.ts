import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentlinkError } from '../src/control-plane/errors.js';
import {
  DEFAULT_CONTEXT_SCOPE,
  DEFAULT_GROUP_TONE,
  DEFAULT_GROUP_TYPE,
  DEFAULT_MEMORY_SCOPE,
  DEFAULT_REPLY_MODE,
  normalizeExternalGroupId,
  normalizeGroupPlatform,
  normalizeGroupScope,
  normalizeGroupToken,
  normalizeReplyMode,
} from '../src/domain/group-profile.js';

test('group profile defaults and normalization follow AL-M1-005 rules', () => {
  assert.equal(DEFAULT_GROUP_TYPE, 'general');
  assert.equal(DEFAULT_GROUP_TONE, 'neutral');
  assert.equal(DEFAULT_REPLY_MODE, 'thread');
  assert.equal(DEFAULT_CONTEXT_SCOPE, 'group');
  assert.equal(DEFAULT_MEMORY_SCOPE, 'group');
  assert.equal(normalizeGroupPlatform(' Feishu.Open_ID '), 'feishu.open_id');
  assert.equal(normalizeExternalGroupId(' Group-ABC '), 'Group-ABC');
  assert.equal(normalizeReplyMode('thread'), 'thread');
  assert.equal(normalizeReplyMode('dialog'), 'dialog');
  assert.equal(normalizeGroupToken('work.group', 'group_type'), 'work.group');
  assert.equal(normalizeGroupScope('group.memory:v1', 'memory_scope'), 'group.memory:v1');
});

test('normalizeExternalGroupId trims but does not lowercase', () => {
  assert.equal(normalizeExternalGroupId('  MixedCase-GID  '), 'MixedCase-GID');
});

test('group profile normalization rejects invalid values with AgentlinkError 400', () => {
  for (const run of [
    () => normalizeGroupPlatform('9bad'),
    () => normalizeExternalGroupId('   '),
    () => normalizeExternalGroupId('x'.repeat(513)),
    () => normalizeReplyMode('reply'),
    () => normalizeGroupToken('-bad', 'group_type'),
    () => normalizeGroupToken('has space', 'tone'),
    () => normalizeGroupScope('', 'context_scope'),
    () => normalizeGroupScope('has space', 'memory_scope'),
    () => normalizeGroupScope('x'.repeat(129), 'memory_scope'),
  ]) {
    assert.throws(
      run,
      (error) => error instanceof AgentlinkError && error.statusCode === 400 && error.code === 'AL_BAD_REQUEST',
    );
  }
});
