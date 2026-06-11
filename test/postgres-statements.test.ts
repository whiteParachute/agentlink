import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_LEASE_STATUSES_SQL, PostgreSqlStatements, getPostgreSqlStatement } from '../src/db/postgres-statements.js';

test('PostgreSQL active lease status literal matches Draft 3 active definition', () => {
  assert.equal(ACTIVE_LEASE_STATUSES_SQL, "('ISSUED', 'ACKED', 'RENEWED')");
});

test('leaseNextQueuedRun locks queued runs and relies on the active lease database guard', () => {
  const sql = getPostgreSqlStatement('leaseNextQueuedRun');
  assert.match(sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(sql, /r\.status = 'QUEUED'/i);
  assert.match(sql, /active_lease\.status IN \('ISSUED', 'ACKED', 'RENEWED'\)/i);
  assert.match(sql, /INSERT INTO al_run_lease/i);
  assert.match(sql, /SET status = 'LEASED'/i);
  assert.match(sql, /current_lease_id = l\.id/i);
});

test('ack statements require the lease state that the protocol allows', () => {
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /l\.status = 'ISSUED'/i);
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /r\.status = 'LEASED'/i);
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /SET status = 'ACKED'/i);
  assert.match(PostgreSqlStatements.ackLeaseRejected, /SET status = 'REJECTED'/i);
  assert.match(PostgreSqlStatements.ackLeaseRejected, /current_lease_id = NULL/i);
});

test('progress and complete statements require an acknowledged running active lease', () => {
  assert.match(PostgreSqlStatements.appendAgentletProgress, /r\.status = 'RUNNING'/i);
  assert.match(PostgreSqlStatements.appendAgentletProgress, /l\.status IN \('ACKED', 'RENEWED'\)/i);
  assert.match(PostgreSqlStatements.appendAgentletProgress, /ON CONFLICT \(run_id, seq\) DO NOTHING/i);

  assert.match(PostgreSqlStatements.completeRun, /FOR UPDATE OF r, l/i);
  assert.match(PostgreSqlStatements.completeRun, /l\.run_id = r\.id/i);
  assert.match(PostgreSqlStatements.completeRun, /r\.current_lease_id = l\.id/i);
  assert.match(PostgreSqlStatements.completeRun, /l\.status IN \('ACKED', 'RENEWED'\)/i);
  assert.match(PostgreSqlStatements.completeRun, /terminal_payload_hash = \$7/i);
  assert.match(PostgreSqlStatements.completeRun, /UPDATE al_task t/i);
  assert.match(PostgreSqlStatements.completeRun, /END::al_task_status/i);
});

test('terminal complete replay is scoped to the same run and lease', () => {
  assert.match(PostgreSqlStatements.replayTerminalComplete, /l\.id = \$2 AND l\.run_id = r\.id/i);
  assert.match(PostgreSqlStatements.replayTerminalComplete, /r\.id = \$1/i);
  assert.match(PostgreSqlStatements.replayTerminalComplete, /l\.terminal_payload_hash = \$3/i);
  assert.match(PostgreSqlStatements.replayTerminalComplete, /JOIN al_task t ON t\.id = r\.task_id/i);
});
