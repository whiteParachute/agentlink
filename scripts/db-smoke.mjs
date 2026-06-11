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
  max: 1,
  connectionTimeoutMillis: 5_000,
});

const client = await pool.connect();
let created = false;
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await client.query(`SET search_path TO ${schema}`);
  await client.query(migrationSql);
  await client.query(`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schema}'
      AND indexname = 'uq_al_run_lease_active'
      AND indexdef LIKE '%WHERE%'
      AND indexdef LIKE '%ISSUED%'
      AND indexdef LIKE '%ACKED%'
      AND indexdef LIKE '%RENEWED%'
  ) THEN
    RAISE EXCEPTION 'missing active lease partial unique index in schema ${schema}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = '${schema}'
      AND table_name = 'al_device'
      AND column_name = 'network_scope'
  ) THEN
    RAISE EXCEPTION 'missing al_device.network_scope in schema ${schema}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = '${schema}'
      AND table_name = 'al_task'
      AND column_name = 'idempotency_signature'
  ) THEN
    RAISE EXCEPTION 'missing al_task.idempotency_signature in schema ${schema}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schema}'
      AND tablename = 'al_run'
      AND indexname = 'uq_al_run_task_attempt'
  ) THEN
    RAISE EXCEPTION 'missing uq_al_run_task_attempt in schema ${schema}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schema}'
      AND indexname = 'idx_al_capability_grant_active_runner'
      AND indexdef LIKE '%revoked_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'missing active capability grant lookup index in schema ${schema}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schema}'
      AND indexname = 'idx_al_workdir_grant_active_device'
      AND indexdef LIKE '%revoked_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'missing active workdir grant lookup index in schema ${schema}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = '${schema}'
      AND table_name = 'al_control_action'
      AND column_name = 'acknowledged_at'
  ) THEN
    RAISE EXCEPTION 'missing al_control_action.acknowledged_at in schema ${schema}';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = '${schema}'
      AND indexname = 'idx_al_control_action_device_status_created'
  ) THEN
    RAISE EXCEPTION 'missing control action device/status index in schema ${schema}';
  END IF;
END $$;
`);
  console.log(`PostgreSQL migration smoke passed in temporary schema ${schema}.`);
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
