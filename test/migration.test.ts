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


test('initial migration adds singleton main user profile table', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_main_user_profile/i);
  assert.match(sql, /singleton_key text PRIMARY KEY DEFAULT 'main' CHECK \(singleton_key = 'main'\)/i);
  assert.match(sql, /display_name text NOT NULL DEFAULT 'Main User'/i);
  assert.match(sql, /locale text NOT NULL DEFAULT 'zh-CN'/i);
  assert.match(sql, /timezone text NOT NULL DEFAULT 'Asia\/Shanghai'/i);
  assert.match(sql, /metadata jsonb NOT NULL DEFAULT '\{\}'::jsonb/i);
});

test('initial migration gives main user profile AL-M1-002 retention boundary columns', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_main_user_profile[\s\S]*retention_class al_retention_class NOT NULL DEFAULT 'operational'/i);
  assert.match(sql, /CREATE TABLE al_main_user_profile[\s\S]*memory_space text NOT NULL DEFAULT 'default' CHECK \(memory_space ~/i);
  assert.match(sql, /CREATE TABLE al_main_user_profile[\s\S]*source_system text NOT NULL DEFAULT 'agentlink' CHECK \(source_system ~/i);
  assert.match(sql, /CREATE TABLE al_main_user_profile[\s\S]*sensitivity al_sensitivity NOT NULL DEFAULT 'internal'/i);
});

test('initial migration adds AL-M1-004 channel user and platform identity tables', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_channel_user/i);
  assert.match(sql, /display_name text NOT NULL DEFAULT 'Channel User'/i);
  assert.match(sql, /category text NOT NULL DEFAULT 'unclassified' CHECK \(category ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9._:-\]\{0,63\}\$'\)/i);
  assert.match(sql, /metadata jsonb NOT NULL DEFAULT '\{\}'::jsonb CHECK \(jsonb_typeof\(metadata\) = 'object'\)/i);
  assert.match(sql, /CREATE INDEX idx_al_channel_user_category/i);

  assert.match(sql, /CREATE TABLE al_platform_identity/i);
  assert.match(sql, /channel_user_id uuid NOT NULL REFERENCES al_channel_user\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /platform text NOT NULL CHECK \(platform ~ '\^\[a-z\]\[a-z0-9._:-\]\{0,63\}\$'\)/i);
  assert.match(sql, /external_id text NOT NULL CHECK \(length\(external_id\) BETWEEN 1 AND 512\)/i);
  assert.match(sql, /normalized_external_id text NOT NULL CHECK \(length\(normalized_external_id\) BETWEEN 1 AND 512\)/i);
  assert.match(sql, /UNIQUE \(platform, normalized_external_id\)/i);
  assert.match(sql, /CREATE INDEX idx_al_platform_identity_channel_user/i);
});

test('initial migration gives AL-M1-004 identity tables retention boundary columns', () => {
  const sql = loadInitialMigration();
  for (const table of ['al_channel_user', 'al_platform_identity']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}[\\s\\S]*retention_class al_retention_class NOT NULL DEFAULT 'operational'`, 'i'));
    assert.match(sql, new RegExp(`CREATE TABLE ${table}[\\s\\S]*memory_space text NOT NULL DEFAULT 'default' CHECK \\(memory_space ~`, 'i'));
    assert.match(sql, new RegExp(`CREATE TABLE ${table}[\\s\\S]*source_system text NOT NULL DEFAULT 'agentlink' CHECK \\(source_system ~`, 'i'));
    assert.match(sql, new RegExp(`CREATE TABLE ${table}[\\s\\S]*sensitivity al_sensitivity NOT NULL DEFAULT 'internal'`, 'i'));
  }
});

test('initial migration adds AL-M1-005 group profile table only', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_group_profile/i);
  assert.match(sql, /platform text NOT NULL CHECK \(platform ~ '\^\[a-z\]\[a-z0-9._:-\]\{0,63\}\$'\)/i);
  assert.match(sql, /external_group_id text NOT NULL CHECK \(length\(btrim\(external_group_id\)\) BETWEEN 1 AND 512\)/i);
  assert.match(sql, /normalized_external_group_id text NOT NULL CHECK \(length\(btrim\(normalized_external_group_id\)\) BETWEEN 1 AND 512\)/i);
  assert.match(sql, /display_name text NOT NULL DEFAULT 'Group'/i);
  assert.match(sql, /group_type text NOT NULL DEFAULT 'general' CHECK \(group_type ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9._:-\]\{0,63\}\$'\)/i);
  assert.match(sql, /tone text NOT NULL DEFAULT 'neutral' CHECK \(tone ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9._:-\]\{0,63\}\$'\)/i);
  assert.match(sql, /default_reply_mode text NOT NULL DEFAULT 'thread' CHECK \(default_reply_mode IN \('thread', 'dialog'\)\)/i);
  assert.match(sql, /context_scope text NOT NULL DEFAULT 'group' CHECK \(context_scope ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9._:-\]\{0,127\}\$'\)/i);
  assert.match(sql, /memory_scope text NOT NULL DEFAULT 'group' CHECK \(memory_scope ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9._:-\]\{0,127\}\$'\)/i);
  assert.match(sql, /metadata jsonb NOT NULL DEFAULT '\{\}'::jsonb CHECK \(jsonb_typeof\(metadata\) = 'object'\)/i);
  assert.match(sql, /UNIQUE \(platform, normalized_external_group_id\)/i);
  assert.match(sql, /CREATE INDEX idx_al_group_profile_group_type/i);
  assert.match(sql, /CREATE INDEX idx_al_group_profile_retention ON al_group_profile\(memory_space, retention_class\)/i);
  const groupTableSql = sql.match(/CREATE TABLE al_group_profile \([\s\S]*?\n\);/i)?.[0] ?? '';
  assert.notEqual(groupTableSql, '');
  assert.doesNotMatch(groupTableSql, /main_user_id/i);
  assert.doesNotMatch(groupTableSql, /tenant_id/i);
});

test('initial migration gives AL-M1-005 group profile retention boundary columns', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_group_profile[\s\S]*retention_class al_retention_class NOT NULL DEFAULT 'operational'/i);
  assert.match(sql, /CREATE TABLE al_group_profile[\s\S]*memory_space text NOT NULL DEFAULT 'default' CHECK \(memory_space ~/i);
  assert.match(sql, /CREATE TABLE al_group_profile[\s\S]*source_system text NOT NULL DEFAULT 'agentlink' CHECK \(source_system ~/i);
  assert.match(sql, /CREATE TABLE al_group_profile[\s\S]*sensitivity al_sensitivity NOT NULL DEFAULT 'internal'/i);
});

test('initial migration adds AL-M1-006 source event and entry tables without memory scope creep', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_source_event/i);
  assert.match(sql, /source_hash text NOT NULL CHECK \(source_hash ~ '\^hmac-sha256:v1:\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(sql, /UNIQUE \(source_system, source_hash\)/i);
  assert.match(sql, /CREATE TABLE al_entry/i);
  assert.match(sql, /source_event_id uuid NOT NULL REFERENCES al_source_event\(id\) ON DELETE CASCADE UNIQUE/i);
  assert.match(sql, /entry_type text NOT NULL DEFAULT 'unknown' CHECK \(entry_type IN \('dm', 'group', 'thread', 'web', 'unknown'\)\)/i);
  assert.match(sql, /speaker_channel_user_id uuid REFERENCES al_channel_user\(id\)/i);
  assert.match(sql, /group_profile_id uuid REFERENCES al_group_profile\(id\)/i);
  assert.match(sql, /CREATE INDEX idx_al_source_event_source_received/i);
  assert.match(sql, /CREATE INDEX idx_al_entry_platform_chat/i);
  assert.doesNotMatch(sql, /CREATE TABLE al_memory\s*\(/i);
  assert.doesNotMatch(sql, /CREATE TABLE al_memory_bridge\s*\(/i);
});


test('initial migration gives AL-M1-006 ingress tables short-term retention boundaries', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_source_event[\s\S]*retention_class al_retention_class NOT NULL DEFAULT 'short_term'/i);
  assert.match(sql, /CREATE TABLE al_source_event[\s\S]*memory_space text NOT NULL DEFAULT 'default' CHECK \(memory_space ~/i);
  assert.match(sql, /CREATE TABLE al_source_event[\s\S]*sensitivity al_sensitivity NOT NULL DEFAULT 'internal'/i);
  assert.match(sql, /CREATE TABLE al_entry[\s\S]*retention_class al_retention_class NOT NULL DEFAULT 'short_term'/i);
  assert.match(sql, /CREATE TABLE al_entry[\s\S]*memory_space text NOT NULL DEFAULT 'default' CHECK \(memory_space ~/i);
  assert.match(sql, /CREATE TABLE al_entry[\s\S]*source_system text NOT NULL DEFAULT 'agentlink' CHECK \(source_system ~/i);
  assert.match(sql, /CREATE TABLE al_entry[\s\S]*sensitivity al_sensitivity NOT NULL DEFAULT 'internal'/i);
  assert.match(sql, /CREATE INDEX idx_al_source_event_retention ON al_source_event\(memory_space, retention_class\)/i);
  assert.match(sql, /CREATE INDEX idx_al_entry_retention ON al_entry\(memory_space, retention_class\)/i);
});


test('initial migration adds AL-M1-010 session table without MainUser or tenant fields', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_session/i);
  assert.match(sql, /session_scope text NOT NULL CHECK \(session_scope IN \('large','small'\)\)/i);
  assert.match(sql, /parent_session_id uuid REFERENCES al_session\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /group_profile_id uuid REFERENCES al_group_profile\(id\)/i);
  assert.match(sql, /UNIQUE \(session_scope, natural_key\)/i);
  assert.match(sql, /session_id uuid REFERENCES al_session\(id\)/i);
  assert.match(sql, /CREATE INDEX idx_al_session_parent ON al_session\(parent_session_id\)/i);
  assert.match(sql, /CREATE INDEX idx_al_session_scope_natural ON al_session\(session_scope, natural_key\)/i);
  assert.match(sql, /CREATE INDEX idx_al_entry_session ON al_entry\(session_id\)/i);
  const sessionTableSql = sql.match(/CREATE TABLE al_session \([\s\S]*?\n\);/i)?.[0] ?? '';
  assert.doesNotMatch(sessionTableSql, /main_user_id/i);
  assert.doesNotMatch(sessionTableSql, /singleton_key/i);
  assert.doesNotMatch(sessionTableSql, /tenant/i);
  assert.doesNotMatch(sql, /CREATE TABLE al_memory\s*\(/i);
  assert.doesNotMatch(sql, /CREATE TABLE al_memory_bridge\s*\(/i);
  assert.doesNotMatch(sql, /0002/i);
});

test('initial migration gives AL-M1-010 sessions operational retention boundaries', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_session[\s\S]*retention_class al_retention_class NOT NULL DEFAULT 'operational'/i);
  assert.match(sql, /CREATE TABLE al_session[\s\S]*memory_space text NOT NULL DEFAULT 'default' CHECK \(memory_space ~/i);
  assert.match(sql, /CREATE TABLE al_session[\s\S]*source_system text NOT NULL DEFAULT 'agentlink' CHECK \(source_system ~/i);
  assert.match(sql, /CREATE TABLE al_session[\s\S]*sensitivity al_sensitivity NOT NULL DEFAULT 'internal'/i);
  assert.match(sql, /CREATE INDEX idx_al_session_retention ON al_session\(memory_space, retention_class\)/i);
});

test('initial migration adds AL-M1-011 memory candidate table without finalized memory tables', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_memory_candidate/i);
  assert.match(sql, /session_id uuid NOT NULL REFERENCES al_session\(id\) ON DELETE CASCADE/i);
  assert.match(sql, /entry_id uuid REFERENCES al_entry\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /source_event_id uuid REFERENCES al_source_event\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /candidate_text text NOT NULL CHECK \(length\(btrim\(candidate_text\)\) BETWEEN 1 AND 8192\)/i);
  assert.match(sql, /status text NOT NULL DEFAULT 'pending' CHECK \(status IN \('pending','accepted','rejected'\)\)/i);
  assert.match(sql, /confidence numeric\(4,3\) CHECK \(confidence IS NULL OR \(confidence >= 0 AND confidence <= 1\)\)/i);
  assert.match(sql, /UNIQUE \(session_id, natural_key\)/i);
  assert.match(sql, /CREATE INDEX idx_al_memory_candidate_session ON al_memory_candidate\(session_id\)/i);
  assert.match(sql, /CREATE INDEX idx_al_memory_candidate_status ON al_memory_candidate\(status\)/i);
  assert.match(sql, /CREATE INDEX idx_al_memory_candidate_retention ON al_memory_candidate\(memory_space, retention_class\)/i);
  assert.doesNotMatch(sql, /CREATE TABLE al_memory\s*\(/i);
  assert.doesNotMatch(sql, /CREATE TABLE al_memory_bridge\s*\(/i);
  assert.doesNotMatch(sql, /CREATE TABLE al_memory_candidate[\s\S]*main_user_id/i);
});

test('initial migration gives AL-M1-011 memory candidates memory_candidate retention boundaries', () => {
  const sql = loadInitialMigration();
  assert.match(sql, /CREATE TABLE al_memory_candidate[\s\S]*retention_class al_retention_class NOT NULL DEFAULT 'memory_candidate'/i);
  assert.match(sql, /CREATE TABLE al_memory_candidate[\s\S]*memory_space text NOT NULL DEFAULT 'default' CHECK \(memory_space ~/i);
  assert.match(sql, /CREATE TABLE al_memory_candidate[\s\S]*source_system text NOT NULL DEFAULT 'agentlink' CHECK \(source_system ~/i);
  assert.match(sql, /CREATE TABLE al_memory_candidate[\s\S]*sensitivity al_sensitivity NOT NULL DEFAULT 'internal'/i);
});
