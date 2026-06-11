#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.AGENTLINK_DATABASE_URL;
if (!databaseUrl) {
  console.log('AGENTLINK_DATABASE_URL is not set; skipping PostgreSQL smoke.');
  process.exit(0);
}

const psqlProbe = spawnSync('psql', ['--version'], { encoding: 'utf8' });
if (psqlProbe.error || psqlProbe.status !== 0) {
  console.error('psql is required when AGENTLINK_DATABASE_URL is set.');
  if (psqlProbe.error) console.error(psqlProbe.error.message);
  process.exit(1);
}

const migrationPath = resolve(process.cwd(), 'migrations/0001_initial.sql');
if (!existsSync(migrationPath)) {
  console.error(`Missing migration file: ${migrationPath}`);
  process.exit(1);
}

const schema = `agentlink_smoke_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const tempDir = mkdtempSync(join(tmpdir(), 'agentlink-db-smoke-'));
const smokePath = join(tempDir, 'smoke.sql');
const migrationSql = readFileSync(migrationPath, 'utf8');

const smokeSql = `
CREATE SCHEMA ${schema};
SET search_path TO ${schema};
${migrationSql}
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
END $$;
DROP SCHEMA ${schema} CASCADE;
`;

writeFileSync(smokePath, smokeSql);
const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', smokePath], { encoding: 'utf8' });
rmSync(tempDir, { recursive: true, force: true });

if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

console.log(`PostgreSQL migration smoke passed in temporary schema ${schema}.`);
