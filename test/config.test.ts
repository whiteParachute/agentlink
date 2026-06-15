import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';

test('loadConfig exposes PostgreSQL runtime settings without requiring a DSN', () => {
  const config = loadConfig({});

  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.storage, 'memory');
  assert.equal(config.databasePoolMax, 10);
  assert.equal(config.databaseIdleTimeoutMs, 30_000);
  assert.equal(config.databaseConnectionTimeoutMs, 5_000);
});

test('loadConfig reads PostgreSQL runtime settings from env', () => {
  const config = loadConfig({
    AGENTLINK_DATABASE_URL: 'postgres://localhost/agentlink',
    AGENTLINK_STORAGE: 'postgres',
    AGENTLINK_DATABASE_POOL_MAX: '3',
    AGENTLINK_DATABASE_IDLE_TIMEOUT_MS: '4000',
    AGENTLINK_DATABASE_CONNECTION_TIMEOUT_MS: '2000',
  });

  assert.equal(config.databaseUrl, 'postgres://localhost/agentlink');
  assert.equal(config.storage, 'postgres');
  assert.equal(config.databasePoolMax, 3);
  assert.equal(config.databaseIdleTimeoutMs, 4_000);
  assert.equal(config.databaseConnectionTimeoutMs, 2_000);
});

test('loadConfig rejects unknown storage modes', () => {
  assert.throws(() => loadConfig({ AGENTLINK_STORAGE: 'sqlite' }), /Invalid AGENTLINK_STORAGE/);
});


test('loadConfig fails fast in production without source hash secret', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', AGENTLINK_INGRESS_BEARER_TOKEN: 'ingress-token' }),
    /AGENTLINK_SOURCE_HASH_SECRET is required/,
  );
});

test('loadConfig fails fast in production without ingress bearer token', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', AGENTLINK_SOURCE_HASH_SECRET: 'source-secret' }),
    /AGENTLINK_INGRESS_BEARER_TOKEN is required/,
  );
});

test('loadConfig accepts production when source hash secret and ingress bearer token are configured', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    AGENTLINK_SOURCE_HASH_SECRET: 'source-secret',
    AGENTLINK_INGRESS_BEARER_TOKEN: 'ingress-token',
  });
  assert.equal(config.environment, 'production');
  assert.equal(config.sourceHashSecret, 'source-secret');
  assert.equal(config.sourceHashSecretConfigured, true);
  assert.equal(config.ingressBearerToken, 'ingress-token');
});
