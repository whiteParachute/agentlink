import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';

test('loadConfig exposes PostgreSQL runtime settings without requiring a DSN', () => {
  const config = loadConfig({});

  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.databasePoolMax, 10);
  assert.equal(config.databaseIdleTimeoutMs, 30_000);
  assert.equal(config.databaseConnectionTimeoutMs, 5_000);
});

test('loadConfig reads PostgreSQL runtime settings from env', () => {
  const config = loadConfig({
    AGENTLINK_DATABASE_URL: 'postgres://localhost/agentlink',
    AGENTLINK_DATABASE_POOL_MAX: '3',
    AGENTLINK_DATABASE_IDLE_TIMEOUT_MS: '4000',
    AGENTLINK_DATABASE_CONNECTION_TIMEOUT_MS: '2000',
  });

  assert.equal(config.databaseUrl, 'postgres://localhost/agentlink');
  assert.equal(config.databasePoolMax, 3);
  assert.equal(config.databaseIdleTimeoutMs, 4_000);
  assert.equal(config.databaseConnectionTimeoutMs, 2_000);
});
