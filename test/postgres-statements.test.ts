import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_LEASE_STATUSES_SQL, PostgreSqlStatements, getPostgreSqlStatement } from '../src/db/postgres-statements.js';

test('PostgreSQL active lease status literal matches Draft 3 active definition', () => {
  assert.equal(ACTIVE_LEASE_STATUSES_SQL, "('ISSUED', 'ACKED', 'RENEWED')");
});

test('task creation stores idempotency signature and creates initial queued run', () => {
  assert.match(PostgreSqlStatements.findTaskByIdempotencyKey, /t\.idempotency_key = \$2/i);
  assert.match(PostgreSqlStatements.findTaskByIdempotencyKey, /JOIN al_run r ON r\.id = t\.current_run_id/i);

  const sql = getPostgreSqlStatement('createTaskWithInitialRun');
  assert.match(sql, /idempotency_signature/i);
  assert.match(sql, /'QUEUED'/i);
  assert.match(sql, /INSERT INTO al_run/i);
  assert.match(sql, /attempt_no/i);
  assert.match(sql, /SET current_run_id = r\.id/i);
});

test('leaseNextQueuedRun locks only queued run rows and relies on active lease database guard', () => {
  const sql = getPostgreSqlStatement('leaseNextQueuedRun');
  assert.match(sql, /FOR UPDATE OF r SKIP LOCKED/i);
  assert.doesNotMatch(sql, /JOIN al_task t ON t\.id = r\.task_id/i);
  assert.match(sql, /r\.status = 'QUEUED'/i);
  assert.match(sql, /active_lease\.status IN \('ISSUED', 'ACKED', 'RENEWED'\)/i);
  assert.match(sql, /INSERT INTO al_run_lease/i);
  assert.match(sql, /SET status = 'LEASED'/i);
  assert.match(sql, /current_lease_id = l\.id/i);
});

test('live repository dispatch statements preserve policy-before-lease and checked active lease boundaries', () => {
  assert.match(PostgreSqlStatements.findDispatchCandidates, /r\.status = 'QUEUED'/i);
  assert.match(PostgreSqlStatements.findDispatchCandidates, /ORDER BY r\.created_at ASC, r\.id ASC/i);

  const sql = getPostgreSqlStatement('leaseSpecificQueuedRun');
  assert.match(sql, /r\.id = \$1/i);
  assert.match(sql, /d\.id = \$2/i);
  assert.match(sql, /runner\.id = \$3/i);
  assert.match(sql, /FOR UPDATE OF r SKIP LOCKED/i);
  assert.match(sql, /active_lease\.status IN \('ISSUED', 'ACKED', 'RENEWED'\)/i);
  assert.match(sql, /policy_decision_id = \$8/i);
  assert.match(sql, /SET status = 'LEASED'/i);
});

test('device runtime statements register, authenticate, and heartbeat devices without exposing secrets', () => {
  assert.match(PostgreSqlStatements.insertDevice, /token_hash/i);
  assert.match(PostgreSqlStatements.insertDevice, /status,/i);
  assert.match(PostgreSqlStatements.insertRunner, /INSERT INTO al_runner/i);
  assert.match(PostgreSqlStatements.insertCapabilityDeclared, /ON CONFLICT \(device_id, runner_id, name, scope\)/i);
  assert.match(PostgreSqlStatements.insertCapabilityGrant, /grant_status/i);
  assert.match(PostgreSqlStatements.insertWorkdirGrant, /path_prefix/i);
  assert.match(PostgreSqlStatements.findDeviceById, /WHERE d\.id = \$1/i);
  assert.match(PostgreSqlStatements.findRunnerById, /json_agg\(cd\.name ORDER BY cd\.name\)/i);
  assert.match(PostgreSqlStatements.heartbeatDevice, /status = 'ONLINE'/i);
  assert.match(PostgreSqlStatements.heartbeatDevice, /last_heartbeat_at = \$2/i);
  assert.match(PostgreSqlStatements.heartbeatDevice, /status <> 'REVOKED'/i);
});

test('policy grant statements look up only active grants and persist policy decisions', () => {
  assert.match(PostgreSqlStatements.findActiveCapabilityGrantsForRunner, /FROM al_capability_grant/i);
  assert.match(PostgreSqlStatements.findActiveCapabilityGrantsForRunner, /device_id = \$2/i);
  assert.match(PostgreSqlStatements.findActiveCapabilityGrantsForRunner, /runner_id = \$3/i);
  assert.match(PostgreSqlStatements.findActiveCapabilityGrantsForRunner, /capability = ANY\(\$4::text\[\]\)/i);
  assert.match(PostgreSqlStatements.findActiveCapabilityGrantsForRunner, /grant_status = 'GRANTED'/i);
  assert.match(PostgreSqlStatements.findActiveCapabilityGrantsForRunner, /revoked_at IS NULL/i);

  assert.match(PostgreSqlStatements.findActiveWorkdirGrantsForDevice, /FROM al_workdir_grant/i);
  assert.match(PostgreSqlStatements.findActiveWorkdirGrantsForDevice, /device_id = \$2/i);
  assert.match(PostgreSqlStatements.findActiveWorkdirGrantsForDevice, /revoked_at IS NULL/i);
  assert.match(PostgreSqlStatements.findActiveWorkdirGrantsForDevice, /ORDER BY length\(path_prefix\) DESC/i);

  assert.match(PostgreSqlStatements.insertPolicyDecision, /INSERT INTO al_policy_decision/i);
  assert.match(PostgreSqlStatements.insertPolicyDecision, /decision/i);
  assert.match(PostgreSqlStatements.insertPolicyDecision, /RETURNING \*/i);
});

test('ack statements require the lease state that the protocol allows', () => {
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /l\.status = 'ISSUED'/i);
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /r\.current_lease_id = l\.id/i);
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /r\.status = 'LEASED'/i);
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /FOR UPDATE OF l, r/i);
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /started_at = COALESCE\(r\.started_at, \$3\)/i);
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /SET status = 'ACKED'/i);
  assert.match(PostgreSqlStatements.ackLeaseAccepted, /row_to_json\(t\) AS task/i);
  assert.match(PostgreSqlStatements.ackLeaseRejected, /r\.current_lease_id = l\.id/i);
  assert.match(PostgreSqlStatements.ackLeaseRejected, /r\.status = 'LEASED'/i);
  assert.match(PostgreSqlStatements.ackLeaseRejected, /FOR UPDATE OF l, r/i);
  assert.match(PostgreSqlStatements.ackLeaseRejected, /SET status = 'REJECTED'/i);
  assert.match(PostgreSqlStatements.ackLeaseRejected, /current_lease_id = NULL/i);
});

test('progress and complete statements require an acknowledged running active lease', () => {
  assert.match(PostgreSqlStatements.appendAgentletProgress, /r\.status = 'RUNNING'/i);
  assert.match(PostgreSqlStatements.appendAgentletProgress, /l\.status IN \('ACKED', 'RENEWED'\)/i);
  assert.match(PostgreSqlStatements.appendAgentletProgress, /ON CONFLICT \(run_id, seq\) DO NOTHING/i);
  assert.match(PostgreSqlStatements.findAgentletProgressBySeq, /WHERE e\.run_id = \$1/i);
  assert.match(PostgreSqlStatements.findAgentletProgressBySeq, /AND e\.seq = \$2/i);
  assert.match(PostgreSqlStatements.findAgentletProgressBySeq, /l\.id = \$3/i);
  assert.match(PostgreSqlStatements.findAgentletProgressBySeq, /r\.current_lease_id = l\.id/i);
  assert.match(PostgreSqlStatements.findAgentletProgressBySeq, /l\.status IN \('ACKED', 'RENEWED'\)/i);

  assert.match(PostgreSqlStatements.completeRun, /FOR UPDATE OF r, l, t/i);
  assert.match(PostgreSqlStatements.completeRun, /JOIN al_task t ON t\.id = r\.task_id AND t\.current_run_id = r\.id/i);
  assert.match(PostgreSqlStatements.completeRun, /l\.run_id = r\.id/i);
  assert.match(PostgreSqlStatements.completeRun, /r\.current_lease_id = l\.id/i);
  assert.match(PostgreSqlStatements.completeRun, /l\.status IN \('ACKED', 'RENEWED'\)/i);
  assert.match(PostgreSqlStatements.completeRun, /terminal_payload_hash = \$7/i);
  assert.match(PostgreSqlStatements.completeRun, /metrics = COALESCE\(\$6::jsonb, r\.metrics\)/i);
  assert.match(PostgreSqlStatements.completeRun, /UPDATE al_task t/i);
  assert.match(PostgreSqlStatements.completeRun, /END::al_task_status/i);
});

test('terminal complete replay is scoped to the same run and lease', () => {
  assert.match(PostgreSqlStatements.replayTerminalComplete, /l\.id = \$2 AND l\.run_id = r\.id/i);
  assert.match(PostgreSqlStatements.replayTerminalComplete, /r\.id = \$1/i);
  assert.match(PostgreSqlStatements.replayTerminalComplete, /l\.terminal_payload_hash = \$3/i);
  assert.match(PostgreSqlStatements.replayTerminalComplete, /JOIN al_task t ON t\.id = r\.task_id/i);
  assert.match(PostgreSqlStatements.findTerminalCompleteByRunLease, /l\.id = \$2 AND l\.run_id = r\.id/i);
  assert.doesNotMatch(PostgreSqlStatements.findTerminalCompleteByRunLease, /terminal_payload_hash = \$3/i);
});

test('retry and lease-expiry statements preserve new-attempt model', () => {
  assert.match(PostgreSqlStatements.createRetryRunAttempt, /previous\.attempt_no \+ 1/i);
  assert.match(PostgreSqlStatements.createRetryRunAttempt, /retry_of_run_id/i);
  assert.match(PostgreSqlStatements.createRetryRunAttempt, /t\.retry_count < t\.max_retries/i);
  assert.match(PostgreSqlStatements.createRetryRunAttempt, /t\.current_run_id = previous\.id/i);
  assert.match(PostgreSqlStatements.createRetryRunAttempt, /t\.status IN \('RUNNING', 'FAILED'\)/i);
  assert.match(PostgreSqlStatements.createRetryRunAttempt, /retry_count = t\.retry_count \+ 1/i);
  assert.match(PostgreSqlStatements.createRetryRunAttempt, /current_run_id = r\.id/i);

  assert.match(PostgreSqlStatements.expireActiveLease, /l\.expires_at <= \$2/i);
  assert.match(PostgreSqlStatements.expireActiveLease, /SET status = 'EXPIRED'/i);
  assert.match(PostgreSqlStatements.expireActiveLease, /SET status = 'TIMED_OUT'/i);
  assert.match(PostgreSqlStatements.expireActiveLease, /SET status = 'FAILED'/i);
  assert.match(PostgreSqlStatements.expireActiveLease, /t\.current_run_id = r\.id/i);
});

test('cancelTask can cancel current non-terminal task/run/lease without agentlet complete', () => {
  assert.match(PostgreSqlStatements.cancelTask, /t\.status NOT IN \('SUCCEEDED', 'FAILED', 'CANCELLED'\)/i);
  assert.match(PostgreSqlStatements.cancelTask, /r\.status NOT IN \('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'\)/i);
  assert.match(PostgreSqlStatements.cancelTask, /l\.status IN \('ISSUED', 'ACKED', 'RENEWED'\)/i);
  assert.match(PostgreSqlStatements.cancelTask, /SET status = 'CANCELLED'/i);
  assert.match(PostgreSqlStatements.cancelTask, /LEFT JOIN updated_lease/i);
});

test('control poll and recover statements keep cancel and active recovery scopes explicit', () => {
  assert.match(PostgreSqlStatements.listControlActionsForDevice, /l\.device_id = \$1/i);
  assert.match(PostgreSqlStatements.listControlActionsForDevice, /l\.status = 'CANCELLED'/i);
  assert.match(PostgreSqlStatements.listControlActionsForDevice, /r\.status = 'CANCELLED'/i);
  assert.match(PostgreSqlStatements.listControlActionsForDevice, /LIMIT \$2/i);

  assert.match(PostgreSqlStatements.listRecoverableRunsForDevice, /l\.device_id = \$1/i);
  assert.match(PostgreSqlStatements.listRecoverableRunsForDevice, /l\.status IN \('ISSUED', 'ACKED', 'RENEWED'\)/i);
  assert.match(PostgreSqlStatements.listRecoverableRunsForDevice, /r\.current_lease_id = l\.id/i);
  assert.match(PostgreSqlStatements.listRecoverableRunsForDevice, /r\.status IN \('LEASED', 'RUNNING'\)/i);
});
