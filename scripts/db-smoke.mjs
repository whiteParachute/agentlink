#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.AGENTLINK_DATABASE_URL;
if (!databaseUrl) {
  console.log('AGENTLINK_DATABASE_URL is not set; skipping PostgreSQL smoke.');
  process.exit(0);
}

const migrationPath = resolve(process.cwd(), 'migrations/0001_initial.sql');
if (!existsSync(migrationPath)) {
  console.error(`Missing migration file: ${migrationPath}`);
  process.exit(1);
}

const schema = `agentlink_smoke_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const migrationSql = readFileSync(migrationPath, 'utf8');
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'agentlink-db-smoke',
  max: 4,
  connectionTimeoutMillis: 5_000,
});

const client = await pool.connect();
let created = false;
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await client.query(`SET search_path TO ${schema}`);
  await client.query(migrationSql);
  await verifySchemaInvariants(client, schema);
  await verifyBusinessContracts(pool, client, schema);
  console.log(`PostgreSQL migration and contract smoke passed in temporary schema ${schema}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
    } catch (dropError) {
      console.error(dropError instanceof Error ? dropError.message : String(dropError));
      process.exitCode = 1;
    }
  }
  client.release();
  await pool.end();
}

async function verifySchemaInvariants(client, schemaName) {
  await client.query(`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schemaName}'
      AND indexname = 'uq_al_run_lease_active'
      AND indexdef LIKE '%WHERE%'
      AND indexdef LIKE '%ISSUED%'
      AND indexdef LIKE '%ACKED%'
      AND indexdef LIKE '%RENEWED%'
  ) THEN
    RAISE EXCEPTION 'missing active lease partial unique index in schema ${schemaName}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = '${schemaName}'
      AND table_name = 'al_device'
      AND column_name = 'network_scope'
  ) THEN
    RAISE EXCEPTION 'missing al_device.network_scope in schema ${schemaName}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = '${schemaName}'
      AND table_name = 'al_task'
      AND column_name = 'idempotency_signature'
  ) THEN
    RAISE EXCEPTION 'missing al_task.idempotency_signature in schema ${schemaName}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schemaName}'
      AND tablename = 'al_run'
      AND indexname = 'uq_al_run_task_attempt'
  ) THEN
    RAISE EXCEPTION 'missing uq_al_run_task_attempt in schema ${schemaName}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schemaName}'
      AND indexname = 'idx_al_capability_grant_active_runner'
      AND indexdef LIKE '%revoked_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'missing active capability grant lookup index in schema ${schemaName}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schemaName}'
      AND indexname = 'idx_al_workdir_grant_active_device'
      AND indexdef LIKE '%revoked_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'missing active workdir grant lookup index in schema ${schemaName}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = '${schemaName}'
      AND table_name = 'al_control_action'
      AND column_name = 'acknowledged_at'
  ) THEN
    RAISE EXCEPTION 'missing al_control_action.acknowledged_at in schema ${schemaName}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schemaName}'
      AND indexname = 'idx_al_control_action_device_status_created'
  ) THEN
    RAISE EXCEPTION 'missing control action device/status index in schema ${schemaName}';
  END IF;
END $$;
`);
}

async function verifyBusinessContracts(pool, client, schemaName) {
  const fixture = await createFixture(client, 'base');
  await verifyConcurrentPullSkipsLockedRun(pool, schemaName, fixture.runId);
  await verifyActiveLeaseUniqueness(client, fixture);

  const renewFixture = await createFixture(client, 'renew');
  await issueLease(client, renewFixture, 'ISSUED', 'LEASED');
  await assertRowCount(
    client,
    executingLeaseUpdateSql('RENEWED'),
    [renewFixture.leaseId, nowIso(), futureIso()],
    0,
    'renew must reject ISSUED/LEASED leases',
  );
  await acknowledgeLease(client, renewFixture);
  await assertRowCount(
    client,
    executingLeaseUpdateSql('RENEWED'),
    [renewFixture.leaseId, nowIso(), futureIso()],
    1,
    'renew must accept ACKED/RUNNING leases',
  );

  const recoverContinueFixture = await createFixture(client, 'recover_continue');
  await issueLease(client, recoverContinueFixture, 'ISSUED', 'LEASED');
  await assertRowCount(
    client,
    recoverContinueSql(),
    [recoverContinueFixture.leaseId, recoverContinueFixture.deviceId, nowIso(), futureIso()],
    0,
    'recoverContinue must reject ISSUED/LEASED leases',
  );
  await acknowledgeLease(client, recoverContinueFixture);
  await assertRowCount(
    client,
    recoverContinueSql(),
    [recoverContinueFixture.leaseId, recoverContinueFixture.deviceId, nowIso(), futureIso()],
    1,
    'recoverContinue must accept ACKED/RUNNING leases',
  );

  const recoverDiscardFixture = await createFixture(client, 'recover_discard');
  await issueLease(client, recoverDiscardFixture, 'ISSUED', 'LEASED');
  await assertRowCount(
    client,
    recoverDiscardSql(),
    [recoverDiscardFixture.leaseId, recoverDiscardFixture.deviceId, 'smoke_discard', nowIso()],
    1,
    'recoverDiscard must clean up active ISSUED/LEASED leases',
  );

  await verifyControlActionPollAck(client, fixture);
}

async function verifyConcurrentPullSkipsLockedRun(pool, schemaName, runId) {
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query(`SET search_path TO ${schemaName}`);
    await second.query(`SET search_path TO ${schemaName}`);
    await first.query('BEGIN');
    await second.query('BEGIN');
    const locked = await first.query(`
SELECT id
FROM al_run
WHERE id = $1 AND status = 'QUEUED'
FOR UPDATE SKIP LOCKED;
`, [runId]);
    assertEqual(locked.rowCount, 1, 'first concurrent pull should lock one queued run');

    const skipped = await second.query(`
SELECT id
FROM al_run
WHERE id = $1 AND status = 'QUEUED'
FOR UPDATE SKIP LOCKED;
`, [runId]);
    assertEqual(skipped.rowCount, 0, 'second concurrent pull should skip the locked run');
    await first.query('COMMIT');
    await second.query('COMMIT');
  } catch (error) {
    await safeRollback(first);
    await safeRollback(second);
    throw error;
  } finally {
    first.release();
    second.release();
  }
}

async function verifyActiveLeaseUniqueness(client, fixture) {
  await issueLease(client, fixture, 'ISSUED', 'LEASED');
  try {
    await client.query(`
INSERT INTO al_run_lease (id, run_id, domain, device_id, runner_id, status, issued_at, expires_at, created_at, updated_at)
VALUES ($1, $2, 'personal', $3, $4, 'ISSUED', now(), now() + interval '5 minutes', now(), now());
`, [uuidFromLabel(`${fixture.label}-duplicate-lease`), fixture.runId, fixture.deviceId, fixture.runnerId]);
  } catch (error) {
    if (error?.code === '23505') return;
    throw error;
  }
  throw new Error('active lease partial unique index allowed a duplicate active lease');
}

async function verifyControlActionPollAck(client, fixture) {
  await client.query(`
INSERT INTO al_control_action (id, domain, device_id, run_id, lease_id, action_type, status, reason, created_at, updated_at)
VALUES ($1, 'personal', $2, $3, $4, 'cancel_run', 'PENDING', 'smoke_cancel', now(), now());
`, [fixture.controlActionId, fixture.deviceId, fixture.runId, fixture.leaseId]);
  const pending = await client.query(`
SELECT id FROM al_control_action
WHERE device_id = $1 AND status = 'PENDING'
ORDER BY created_at ASC;
`, [fixture.deviceId]);
  assertEqual(pending.rowCount, 1, 'control action poll should return one pending action');

  const acked = await client.query(`
UPDATE al_control_action
SET status = 'ACKED', acknowledged_at = COALESCE(acknowledged_at, now()), updated_at = now()
WHERE id = $1 AND device_id = $2
RETURNING id;
`, [fixture.controlActionId, fixture.deviceId]);
  assertEqual(acked.rowCount, 1, 'control action ack should update one action');

  const afterAck = await client.query(`
SELECT id FROM al_control_action
WHERE device_id = $1 AND status = 'PENDING';
`, [fixture.deviceId]);
  assertEqual(afterAck.rowCount, 0, 'acked control actions must not poll as pending');
}

async function createFixture(client, label) {
  const fixture = {
    label,
    taskId: uuidFromLabel(`${label}-task`),
    runId: uuidFromLabel(`${label}-run`),
    deviceId: uuidFromLabel(`${label}-device`),
    runnerId: uuidFromLabel(`${label}-runner`),
    leaseId: uuidFromLabel(`${label}-lease`),
    controlActionId: uuidFromLabel(`${label}-control-action`),
  };
  await client.query(`
INSERT INTO al_device (id, domain, display_name, token_hash, network_scope, owner_user_id, trust_level, status, last_auth_at, last_heartbeat_at, created_at, updated_at)
VALUES ($1, 'personal', $2, $3, 'personal', 'whiteParachute', 'standard', 'ONLINE', now(), now(), now(), now());
`, [fixture.deviceId, `smoke-${label}`, `token-${label}`]);
  await client.query(`
INSERT INTO al_runner (id, device_id, runner_type, runner_version, status, max_concurrency, created_at, updated_at)
VALUES ($1, $2, 'codex', 'smoke', 'online', 1, now(), now());
`, [fixture.runnerId, fixture.deviceId]);
  await client.query(`
INSERT INTO al_task (id, domain, source, source_ref, payload, task_spec, status, retry_count, max_retries, idempotency_key, idempotency_signature, created_at, updated_at)
VALUES ($1, 'personal', 'smoke', $2, '{}'::jsonb, '{}'::jsonb, 'QUEUED', 0, 1, $3, $4, now(), now());
`, [fixture.taskId, `smoke:${label}`, `idem:${label}`, `signature:${label}`]);
  await client.query(`
INSERT INTO al_run (id, task_id, domain, status, attempt_no, instruction, created_at, updated_at)
VALUES ($1, $2, 'personal', 'QUEUED', 1, '{"type":"codex_session","requiredCapabilities":["codex:exec"]}'::jsonb, now(), now());
`, [fixture.runId, fixture.taskId]);
  await client.query('UPDATE al_task SET current_run_id = $1, updated_at = now() WHERE id = $2;', [fixture.runId, fixture.taskId]);
  return fixture;
}

async function issueLease(client, fixture, leaseStatus, runStatus) {
  await client.query(`
INSERT INTO al_run_lease (id, run_id, domain, device_id, runner_id, status, issued_at, acked_at, expires_at, created_at, updated_at)
VALUES ($1, $2, 'personal', $3, $4, $5, now(), CASE WHEN $5 IN ('ACKED', 'RENEWED') THEN now() ELSE NULL END, now() + interval '5 minutes', now(), now());
`, [fixture.leaseId, fixture.runId, fixture.deviceId, fixture.runnerId, leaseStatus]);
  await client.query('UPDATE al_run SET status = $1, current_lease_id = $2, updated_at = now() WHERE id = $3;', [runStatus, fixture.leaseId, fixture.runId]);
  await client.query("UPDATE al_task SET status = 'RUNNING', updated_at = now() WHERE id = $1;", [fixture.taskId]);
}

async function acknowledgeLease(client, fixture) {
  await client.query(`
UPDATE al_run_lease
SET status = 'ACKED', acked_at = COALESCE(acked_at, now()), updated_at = now(), version = version + 1
WHERE id = $1;
`, [fixture.leaseId]);
  await client.query(`
UPDATE al_run
SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now(), version = version + 1
WHERE id = $1;
`, [fixture.runId]);
}

function executingLeaseUpdateSql(nextLeaseStatus) {
  return `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, l.id AS lease_id
  FROM al_run_lease l
  JOIN al_run r ON r.id = l.run_id
  WHERE l.id = $1
    AND l.status IN ('ACKED', 'RENEWED')
    AND r.current_lease_id = l.id
    AND r.status = 'RUNNING'
  FOR UPDATE OF r, l
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = '${nextLeaseStatus}', renewed_at = $2, expires_at = $3, updated_at = $2, version = l.version + 1
  FROM target
  WHERE l.id = target.lease_id
  RETURNING l.*
)
SELECT * FROM updated_lease;
`;
}

function recoverContinueSql() {
  return `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, l.id AS lease_id
  FROM al_run_lease l
  JOIN al_run r ON r.id = l.run_id
  WHERE l.id = $1
    AND l.device_id = $2
    AND l.status IN ('ACKED', 'RENEWED')
    AND r.current_lease_id = l.id
    AND r.status = 'RUNNING'
  FOR UPDATE OF r, l
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'RENEWED', renewed_at = $3, expires_at = $4, updated_at = $3, version = l.version + 1
  FROM target
  WHERE l.id = target.lease_id
  RETURNING l.*
)
SELECT * FROM updated_lease;
`;
}

function recoverDiscardSql() {
  return `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, l.id AS lease_id
  FROM al_run_lease l
  JOIN al_run r ON r.id = l.run_id
  WHERE l.id = $1
    AND l.device_id = $2
    AND l.status IN ('ISSUED', 'ACKED', 'RENEWED')
    AND r.current_lease_id = l.id
    AND r.status IN ('LEASED', 'RUNNING')
  FOR UPDATE OF r, l
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'EXPIRED', expire_reason = $3, updated_at = $4, version = l.version + 1
  FROM target
  WHERE l.id = target.lease_id
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET status = 'TIMED_OUT', finished_at = $4, updated_at = $4, current_lease_id = NULL, version = r.version + 1
  FROM target
  WHERE r.id = target.run_id
  RETURNING r.*
)
SELECT * FROM updated_run;
`;
}

async function assertRowCount(client, sql, params, expected, message) {
  const result = await client.query(sql, params);
  assertEqual(result.rowCount, expected, message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

async function safeRollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // best-effort cleanup only
  }
}

function nowIso() {
  return new Date().toISOString();
}

function futureIso() {
  return new Date(Date.now() + 5 * 60_000).toISOString();
}

function uuidFromLabel(label) {
  const hex = Buffer.from(label).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
