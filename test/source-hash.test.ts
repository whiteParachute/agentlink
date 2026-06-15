import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSourceHash, isSourceHash, resolveSourceHashSecret, SOURCE_HASH_PREFIX } from '../src/domain/source-hash.js';

void test('source hash is stable HMAC with versioned lowercase format', () => {
  const input = { sourceSystem: 'feishu', sourceRef: 'msg-1', secret: 'secret-a' };
  const first = createSourceHash(input);
  const replay = createSourceHash(input);
  assert.equal(first, replay);
  assert.equal(first.startsWith(SOURCE_HASH_PREFIX), true);
  assert.equal(isSourceHash(first), true);
  assert.match(first, /^hmac-sha256:v1:[0-9a-f]{64}$/);
});

void test('source hash changes when secret/source system/source ref changes and is not bare sha256', () => {
  const base = createSourceHash({ sourceSystem: 'feishu', sourceRef: 'msg-1', secret: 'secret-a' });
  assert.notEqual(base, createSourceHash({ sourceSystem: 'feishu', sourceRef: 'msg-1', secret: 'secret-b' }));
  assert.notEqual(base, createSourceHash({ sourceSystem: 'telegram', sourceRef: 'msg-1', secret: 'secret-a' }));
  assert.notEqual(base, createSourceHash({ sourceSystem: 'feishu', sourceRef: 'msg-2', secret: 'secret-a' }));
  const bare = createHash('sha256').update('feishu').update('\0').update('msg-1').digest('hex');
  assert.notEqual(base.slice(SOURCE_HASH_PREFIX.length), bare);
});

void test('source hash secret resolution uses explicit env or deterministic dev fallback', () => {
  assert.deepEqual(resolveSourceHashSecret({ AGENTLINK_SOURCE_HASH_SECRET: ' prod-secret ' }), { secret: 'prod-secret', configured: true });
  const fallback = resolveSourceHashSecret({});
  assert.equal(fallback.configured, false);
  assert.equal(typeof fallback.secret, 'string');
  assert.ok(fallback.secret.length > 0);
});
