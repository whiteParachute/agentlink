import { ACTIVE_LEASE_STATUSES } from '../domain/status.js';

// SQL contract fragments for the first PostgreSQL repository spike. They are
// intentionally dependency-free and are exercised by text-level invariant tests
// until a live PostgreSQL adapter/client strategy is approved.
export const ACTIVE_LEASE_STATUSES_SQL = `(${ACTIVE_LEASE_STATUSES.map((status) => `'${status}'`).join(', ')})`;

export const PostgreSqlStatements = {
  leaseNextQueuedRun: `
WITH candidate_run AS (
  SELECT r.id, r.task_id, r.domain
  FROM al_run r
  JOIN al_task t ON t.id = r.task_id
  JOIN al_device d ON d.id = $1 AND d.domain = r.domain
  JOIN al_runner runner ON runner.id = $2 AND runner.device_id = d.id
  WHERE r.domain = $3
    AND r.status = 'QUEUED'
    AND d.status = 'ONLINE'
    AND runner.status = 'online'
    AND NOT EXISTS (
      SELECT 1
      FROM al_run_lease active_lease
      WHERE active_lease.run_id = r.id
        AND active_lease.status IN ${ACTIVE_LEASE_STATUSES_SQL}
    )
  ORDER BY r.created_at ASC, r.id ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
), inserted_lease AS (
  INSERT INTO al_run_lease (id, run_id, domain, device_id, runner_id, status, issued_at, expires_at, created_at, updated_at)
  SELECT $4, c.id, c.domain, $1, $2, 'ISSUED', $5, $6, $5, $5
  FROM candidate_run c
  RETURNING *
), updated_run AS (
  UPDATE al_run r
  SET status = 'LEASED', current_lease_id = l.id, updated_at = $5, version = r.version + 1
  FROM inserted_lease l
  WHERE r.id = l.run_id
    AND r.status = 'QUEUED'
    AND r.current_lease_id IS NULL
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = 'RUNNING', updated_at = $5
  FROM updated_run r
  WHERE t.id = r.task_id
  RETURNING t.*
)
SELECT
  row_to_json(l) AS lease,
  row_to_json(r) AS run,
  row_to_json(t) AS task
FROM inserted_lease l
JOIN updated_run r ON r.id = l.run_id
JOIN updated_task t ON t.id = r.task_id;
`,

  ackLeaseAccepted: `
WITH target_lease AS (
  SELECT l.id, l.run_id
  FROM al_run_lease l
  WHERE l.id = $1
    AND l.device_id = $2
    AND l.status = 'ISSUED'
  FOR UPDATE
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'ACKED', acked_at = $3, updated_at = $3, version = l.version + 1
  FROM target_lease target
  WHERE l.id = target.id
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET status = 'RUNNING', started_at = COALESCE(r.started_at, $3), updated_at = $3, version = r.version + 1
  FROM updated_lease l
  WHERE r.id = l.run_id
    AND r.current_lease_id = l.id
    AND r.status = 'LEASED'
  RETURNING r.*
)
SELECT row_to_json(l) AS lease, row_to_json(r) AS run
FROM updated_lease l
JOIN updated_run r ON r.id = l.run_id;
`,

  ackLeaseRejected: `
WITH target_lease AS (
  SELECT l.id, l.run_id
  FROM al_run_lease l
  WHERE l.id = $1
    AND l.device_id = $2
    AND l.status = 'ISSUED'
  FOR UPDATE
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'REJECTED', expire_reason = $3, updated_at = $4, version = l.version + 1
  FROM target_lease target
  WHERE l.id = target.id
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET status = 'QUEUED', current_lease_id = NULL, updated_at = $4, version = r.version + 1
  FROM updated_lease l
  WHERE r.id = l.run_id
    AND r.current_lease_id = l.id
    AND r.status = 'LEASED'
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = 'QUEUED', updated_at = $4
  FROM updated_run r
  WHERE t.id = r.task_id
  RETURNING t.*
)
SELECT row_to_json(l) AS lease, row_to_json(r) AS run, row_to_json(t) AS task
FROM updated_lease l
JOIN updated_run r ON r.id = l.run_id
JOIN updated_task t ON t.id = r.task_id;
`,

  appendAgentletProgress: `
INSERT INTO al_run_event (run_id, seq, domain, event_type, payload, emitted_at)
SELECT r.id, $3, r.domain, $4, $5::jsonb, $6
FROM al_run r
JOIN al_run_lease l ON l.id = $2 AND l.run_id = r.id
WHERE r.id = $1
  AND r.status = 'RUNNING'
  AND r.current_lease_id = l.id
  AND l.status IN ('ACKED', 'RENEWED')
ON CONFLICT (run_id, seq) DO NOTHING
RETURNING *;
`,

  findAgentletProgressBySeq: `
SELECT *
FROM al_run_event
WHERE run_id = $1
  AND seq = $2;
`,

  completeRun: `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, r.domain, l.id AS lease_id
  FROM al_run r
  JOIN al_run_lease l ON l.id = $2 AND l.run_id = r.id
  WHERE r.id = $1
    AND r.status = 'RUNNING'
    AND r.current_lease_id = l.id
    AND l.status IN ('ACKED', 'RENEWED')
  FOR UPDATE OF r, l
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = CASE WHEN $3 = 'CANCELLED' THEN 'CANCELLED' ELSE 'COMPLETED' END::al_lease_status,
      terminal_payload_hash = $7,
      completed_at = CASE WHEN $3 = 'CANCELLED' THEN l.completed_at ELSE $8 END,
      cancelled_at = CASE WHEN $3 = 'CANCELLED' THEN $8 ELSE l.cancelled_at END,
      updated_at = $8,
      version = l.version + 1
  FROM target
  WHERE l.id = target.lease_id
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET status = $3::al_run_status,
      result = $4::jsonb,
      error = $5::jsonb,
      metrics = COALESCE($6::jsonb, r.metrics),
      finished_at = $8,
      updated_at = $8,
      version = r.version + 1
  FROM target
  WHERE r.id = target.run_id
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = CASE
      WHEN $3 = 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN $3 = 'CANCELLED' THEN 'CANCELLED'
      ELSE 'FAILED'
    END::al_task_status,
      updated_at = $8
  FROM updated_run r
  WHERE t.id = r.task_id
  RETURNING t.*
)
SELECT row_to_json(l) AS lease, row_to_json(r) AS run, row_to_json(t) AS task
FROM updated_lease l
JOIN updated_run r ON r.id = l.run_id
JOIN updated_task t ON t.id = r.task_id;
`,

  replayTerminalComplete: `
SELECT row_to_json(r) AS run, row_to_json(l) AS lease, row_to_json(t) AS task
FROM al_run r
JOIN al_run_lease l ON l.id = $2 AND l.run_id = r.id
JOIN al_task t ON t.id = r.task_id
WHERE r.id = $1
  AND r.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
  AND l.terminal_payload_hash = $3;
`,
} as const;

export type PostgreSqlStatementName = keyof typeof PostgreSqlStatements;

export function getPostgreSqlStatement(name: PostgreSqlStatementName): string {
  return PostgreSqlStatements[name];
}
