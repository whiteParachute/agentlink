import { ACTIVE_LEASE_STATUSES } from '../domain/status.js';

// SQL contract fragments for the first PostgreSQL repository spike. They are
// intentionally dependency-free and are exercised by text-level invariant tests
// until a live PostgreSQL adapter/client strategy is approved.
//
// These statements are atomic repository building blocks. Higher-level service
// logic owns retry policy, row-count-to-error mapping, and idempotency conflict
// classification. In particular, appendAgentletProgress returns zero rows on
// (run_id, seq) conflict or stale lease state; callers must query
// findAgentletProgressBySeq with the same active lease to distinguish an
// idempotent replay from AL_IDEMPOTENCY_CONFLICT or AL_LEASE_EXPIRED.
export const ACTIVE_LEASE_STATUSES_SQL = `(${ACTIVE_LEASE_STATUSES.map((status) => `'${status}'`).join(', ')})`;

export const PostgreSqlStatements = {
  findTaskByIdempotencyKey: `
SELECT row_to_json(t) AS task, row_to_json(r) AS run
FROM al_task t
JOIN al_run r ON r.id = t.current_run_id
WHERE t.domain = $1
  AND t.idempotency_key = $2;
`,

  createTaskWithInitialRun: `
WITH inserted_task AS (
  INSERT INTO al_task (
    id,
    domain,
    source,
    source_ref,
    payload,
    task_spec,
    status,
    retry_count,
    max_retries,
    idempotency_key,
    idempotency_signature,
    created_at,
    updated_at
  ) VALUES (
    $1,
    $2,
    $3,
    $4,
    $5::jsonb,
    $6::jsonb,
    'QUEUED',
    0,
    $7,
    $8,
    $9,
    $10,
    $10
  )
  RETURNING *
), inserted_run AS (
  INSERT INTO al_run (
    id,
    task_id,
    domain,
    status,
    attempt_no,
    instruction,
    created_at,
    updated_at
  )
  SELECT $11, t.id, t.domain, 'QUEUED', 1, $12::jsonb, $10, $10
  FROM inserted_task t
  RETURNING *
), updated_task AS (
  UPDATE al_task t
  SET current_run_id = r.id, updated_at = $10
  FROM inserted_run r
  WHERE t.id = r.task_id
  RETURNING t.*
)
SELECT row_to_json(t) AS task, row_to_json(r) AS run
FROM updated_task t
JOIN inserted_run r ON r.task_id = t.id;
`,

  leaseNextQueuedRun: `
WITH candidate_run AS (
  SELECT r.id, r.task_id, r.domain
  FROM al_run r
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
  FOR UPDATE OF r SKIP LOCKED
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
WITH target AS (
  SELECT l.id, l.run_id
  FROM al_run_lease l
  JOIN al_run r ON r.id = l.run_id
  WHERE l.id = $1
    AND l.device_id = $2
    AND l.status = 'ISSUED'
    AND r.current_lease_id = l.id
    AND r.status = 'LEASED'
  FOR UPDATE OF l, r
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'ACKED', acked_at = $3, updated_at = $3, version = l.version + 1
  FROM target
  WHERE l.id = target.id
  RETURNING l.*
), updated_run AS (
  -- started_at records the first successful execution start and is not overwritten by any accidental replay.
  UPDATE al_run r
  SET status = 'RUNNING', started_at = COALESCE(r.started_at, $3), updated_at = $3, version = r.version + 1
  FROM target
  WHERE r.id = target.run_id
  RETURNING r.*
), selected_task AS (
  SELECT t.*
  FROM al_task t
  JOIN updated_run r ON r.task_id = t.id
)
SELECT row_to_json(l) AS lease, row_to_json(r) AS run, row_to_json(t) AS task
FROM updated_lease l
JOIN updated_run r ON r.id = l.run_id
JOIN selected_task t ON t.id = r.task_id;
`,

  ackLeaseRejected: `
WITH target AS (
  SELECT l.id, l.run_id
  FROM al_run_lease l
  JOIN al_run r ON r.id = l.run_id
  WHERE l.id = $1
    AND l.device_id = $2
    AND l.status = 'ISSUED'
    AND r.current_lease_id = l.id
    AND r.status = 'LEASED'
  FOR UPDATE OF l, r
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'REJECTED', expire_reason = $3, updated_at = $4, version = l.version + 1
  FROM target
  WHERE l.id = target.id
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET status = 'QUEUED', current_lease_id = NULL, updated_at = $4, version = r.version + 1
  FROM target
  WHERE r.id = target.run_id
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
SELECT e.*
FROM al_run_event e
JOIN al_run r ON r.id = e.run_id
JOIN al_run_lease l ON l.id = $3 AND l.run_id = r.id
WHERE e.run_id = $1
  AND e.seq = $2
  AND r.status = 'RUNNING'
  AND r.current_lease_id = l.id
  AND l.status IN ('ACKED', 'RENEWED');
`,

  completeRun: `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, r.domain, l.id AS lease_id
  FROM al_run r
  JOIN al_task t ON t.id = r.task_id AND t.current_run_id = r.id
  JOIN al_run_lease l ON l.id = $2 AND l.run_id = r.id
  WHERE r.id = $1
    AND r.status = 'RUNNING'
    AND r.current_lease_id = l.id
    AND l.status IN ('ACKED', 'RENEWED')
  FOR UPDATE OF r, l, t
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

  findTerminalCompleteByRunLease: `
SELECT row_to_json(r) AS run, row_to_json(l) AS lease, row_to_json(t) AS task
FROM al_run r
JOIN al_run_lease l ON l.id = $2 AND l.run_id = r.id
JOIN al_task t ON t.id = r.task_id
WHERE r.id = $1
  AND r.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
`,

  createRetryRunAttempt: `
WITH previous_run AS (
  SELECT r.*
  FROM al_run r
  WHERE r.id = $1
    AND r.status IN ('FAILED', 'TIMED_OUT')
  FOR UPDATE
), target_task AS (
  SELECT t.*
  FROM al_task t
  JOIN previous_run previous ON previous.task_id = t.id
  WHERE t.retry_count < t.max_retries
    AND t.current_run_id = previous.id
    AND t.status IN ('RUNNING', 'FAILED')
  FOR UPDATE
), inserted_run AS (
  INSERT INTO al_run (
    id,
    task_id,
    domain,
    status,
    attempt_no,
    retry_of_run_id,
    instruction,
    metrics,
    created_at,
    updated_at
  )
  SELECT
    $2,
    t.id,
    t.domain,
    'QUEUED',
    previous.attempt_no + 1,
    previous.id,
    previous.instruction,
    '{}'::jsonb,
    $3,
    $3
  FROM target_task t
  JOIN previous_run previous ON previous.task_id = t.id
  RETURNING *
), updated_task AS (
  UPDATE al_task t
  SET status = 'QUEUED',
      current_run_id = r.id,
      retry_count = t.retry_count + 1,
      updated_at = $3
  FROM inserted_run r
  WHERE t.id = r.task_id
  RETURNING t.*
)
SELECT row_to_json(r) AS run, row_to_json(t) AS task
FROM inserted_run r
JOIN updated_task t ON t.id = r.task_id;
`,

  expireActiveLease: `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, l.id AS lease_id
  FROM al_run_lease l
  JOIN al_run r ON r.id = l.run_id
  WHERE l.id = $1
    AND l.status IN ${ACTIVE_LEASE_STATUSES_SQL}
    AND l.expires_at <= $2
    AND r.current_lease_id = l.id
    AND r.status IN ('LEASED', 'RUNNING')
  FOR UPDATE OF r, l
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'EXPIRED', expire_reason = $3, updated_at = $2, version = l.version + 1
  FROM target
  WHERE l.id = target.lease_id
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET status = 'TIMED_OUT', finished_at = $2, updated_at = $2, version = r.version + 1
  FROM target
  WHERE r.id = target.run_id
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = 'FAILED', updated_at = $2
  FROM updated_run r
  WHERE t.id = r.task_id
    AND t.current_run_id = r.id
  RETURNING t.*
)
SELECT row_to_json(l) AS lease, row_to_json(r) AS run, row_to_json(t) AS task
FROM updated_lease l
JOIN updated_run r ON r.id = l.run_id
JOIN updated_task t ON t.id = r.task_id;
`,

  cancelTask: `
WITH target_task AS (
  SELECT t.*
  FROM al_task t
  WHERE t.id = $1
    AND t.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
  FOR UPDATE
), target_run AS (
  SELECT r.*
  FROM al_run r
  JOIN target_task t ON t.current_run_id = r.id
  WHERE r.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
  FOR UPDATE
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'CANCELLED', cancelled_at = $2, expire_reason = $3, updated_at = $2, version = l.version + 1
  FROM target_run r
  WHERE l.id = r.current_lease_id
    AND l.status IN ${ACTIVE_LEASE_STATUSES_SQL}
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET status = 'CANCELLED', finished_at = $2, updated_at = $2, version = r.version + 1
  FROM target_run target
  WHERE r.id = target.id
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = 'CANCELLED', updated_at = $2
  FROM target_task target
  WHERE t.id = target.id
  RETURNING t.*
)
SELECT row_to_json(t) AS task, row_to_json(r) AS run, row_to_json(l) AS lease
FROM updated_task t
LEFT JOIN updated_run r ON r.task_id = t.id
LEFT JOIN updated_lease l ON l.run_id = r.id;
`,
} as const;

export type PostgreSqlStatementName = keyof typeof PostgreSqlStatements;

export function getPostgreSqlStatement(name: PostgreSqlStatementName): string {
  return PostgreSqlStatements[name];
}
