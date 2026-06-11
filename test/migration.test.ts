import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInitialMigration } from '../src/db/schema.js';


test('initial migration includes AL-TD-001 domain and network scope baseline', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TYPE al_domain AS ENUM \('personal', 'work'\)/i);
  assert.match(sql, /domain al_domain NOT NULL DEFAULT 'personal'/i);
  assert.match(sql, /network_scope text NOT NULL DEFAULT 'personal'/i);
});

test('initial migration contains active lease partial unique index', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE UNIQUE INDEX uq_al_run_lease_active/i);
  assert.match(sql, /ON al_run_lease\(run_id\)/i);
  assert.match(sql, /WHERE status IN \('ISSUED', 'ACKED', 'RENEWED'\)/i);
});

test('initial migration includes retry attempt fields', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /attempt_no integer NOT NULL DEFAULT 1/i);
  assert.match(sql, /retry_count integer NOT NULL DEFAULT 0/i);
  assert.match(sql, /max_retries integer NOT NULL DEFAULT 1/i);
  assert.match(sql, /retry_of_run_id uuid REFERENCES al_run\(id\)/i);
});

test('initial migration persists terminal complete replay hash on leases', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /terminal_payload_hash text/i);
});

test('initial migration scopes artifacts by domain and hash', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_artifact/i);
  assert.match(sql, /PRIMARY KEY \(domain, hash\)/i);
});
