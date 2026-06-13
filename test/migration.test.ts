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

test('initial migration stores idempotency signatures for conflict detection', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /idempotency_signature text NOT NULL/i);
  assert.match(sql, /UNIQUE \(domain, idempotency_key\)/i);
});

test('initial migration includes retry attempt fields', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /attempt_no integer NOT NULL DEFAULT 1/i);
  assert.match(sql, /retry_count integer NOT NULL DEFAULT 0/i);
  assert.match(sql, /max_retries integer NOT NULL DEFAULT 1/i);
  assert.match(sql, /retry_of_run_id uuid REFERENCES al_run\(id\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX uq_al_run_task_attempt/i);
  assert.match(sql, /ON al_run\(task_id, attempt_no\)/i);
});

test('initial migration persists terminal complete replay hash on leases', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /terminal_payload_hash text/i);
});

test('initial migration persists agentlet control actions for ack and retention', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_control_action/i);
  assert.match(sql, /action_type text NOT NULL CHECK \(action_type IN \('cancel_run'\)\)/i);
  assert.match(sql, /status text NOT NULL DEFAULT 'PENDING' CHECK \(status IN \('PENDING', 'ACKED'\)\)/i);
  assert.match(sql, /UNIQUE \(device_id, action_type, lease_id\)/i);
  assert.match(sql, /CREATE INDEX idx_al_control_action_device_status_created/i);
});

test('initial migration scopes artifacts by domain and hash', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_artifact/i);
  assert.match(sql, /PRIMARY KEY \(domain, hash\)/i);
});

test('initial migration includes active grant lookup indexes for AL-TD-003 policy checks', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_capability_declared/i);
  assert.match(sql, /CREATE TABLE al_capability_grant/i);
  assert.match(sql, /CREATE TABLE al_workdir_grant/i);
  assert.match(sql, /CREATE UNIQUE INDEX uq_al_capability_grant_active_runner/i);
  assert.match(sql, /ON al_capability_grant\(domain, device_id, runner_id, capability\)/i);
  assert.match(sql, /WHERE grant_status = 'GRANTED' AND revoked_at IS NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX uq_al_workdir_grant_active_device/i);
  assert.match(sql, /ON al_workdir_grant\(domain, device_id, path_prefix, access_mode\)/i);
});

test('initial migration includes AL-M1-002 retention metadata enums', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TYPE al_retention_class AS ENUM \('short_term', 'operational', 'artifact', 'audit', 'memory_candidate', 'memory'\)/i);
  assert.match(sql, /CREATE TYPE al_sensitivity AS ENUM \('public', 'internal', 'confidential', 'secret'\)/i);
});

test('initial migration does not modify al_domain enum', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TYPE al_domain AS ENUM \('personal', 'work'\)/i);
});

const RETENTION_TABLES = [
  { table: 'al_task', defaultClass: 'operational', defaultSource: 'agentlink' },
  { table: 'al_run', defaultClass: 'operational', defaultSource: 'agentlink' },
  { table: 'al_run_event', defaultClass: 'short_term', defaultSource: 'agentlet' },
  { table: 'al_artifact', defaultClass: 'artifact', defaultSource: 'agentlink' },
  { table: 'al_audit_log', defaultClass: 'audit', defaultSource: 'agentlink' },
];

for (const { table, defaultClass, defaultSource } of RETENTION_TABLES) {
  test(`initial migration adds four retention columns on ${table} with defaults and CHECKs`, () => {
    const sql = loadInitialMigration();
    // Columns exist with enum types
    assert.match(sql, new RegExp(`retention_class al_retention_class NOT NULL DEFAULT '${defaultClass}'`, 'i'));
    assert.match(sql, new RegExp(`memory_space text NOT NULL DEFAULT 'default'.*CHECK \\(memory_space ~`, 'si'));
    assert.match(sql, new RegExp(`source_system text NOT NULL DEFAULT '${defaultSource}'.*CHECK \\(source_system ~`, 'si'));
    assert.match(sql, /sensitivity al_sensitivity NOT NULL DEFAULT 'internal'/i);
    // identifier regex pattern is the same across tables
    assert.match(sql, /\^\[A-Za-z0-9\]\[A-Za-z0-9._:-\]\{0,127\}\$/);
  });

  test(`initial migration includes retention lookup index on ${table}`, () => {
    const sql = loadInitialMigration();
    assert.match(sql, new RegExp(`CREATE INDEX idx_al_${table.slice(3)}_retention`, 'i'));
    assert.match(sql, new RegExp(`ON ${table}\\(domain, memory_space, retention_class\\)`, 'i'));
  });
}
