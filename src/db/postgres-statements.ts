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

  findTaskById: `
SELECT row_to_json(t) AS task, row_to_json(r) AS run
FROM al_task t
LEFT JOIN al_run r ON r.id = t.current_run_id
WHERE t.id = $1;
`,

  findRunById: `
SELECT row_to_json(r) AS run
FROM al_run r
WHERE r.id = $1;
`,

  findLeaseById: `
SELECT row_to_json(l) AS lease
FROM al_run_lease l
WHERE l.id = $1;
`,

  listRunEvents: `
SELECT *
FROM al_run_event
WHERE run_id = $1
  AND seq > $2
ORDER BY seq ASC;
`,

  insertDevice: `
INSERT INTO al_device (
  id,
  domain,
  display_name,
  token_hash,
  network_scope,
  owner_user_id,
  trust_level,
  status,
  agentlet_version,
  metadata,
  created_at,
  updated_at
) VALUES (
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  $7,
  'REGISTERED',
  $8,
  $9::jsonb,
  $10,
  $10
)
RETURNING *;
`,

  insertRunner: `
INSERT INTO al_runner (
  id,
  device_id,
  runner_type,
  runner_version,
  model,
  status,
  max_concurrency,
  created_at,
  updated_at
) VALUES (
  $1,
  $2,
  $3,
  $4,
  $5,
  'online',
  $6,
  $7,
  $7
)
RETURNING *;
`,

  insertCapabilityDeclared: `
INSERT INTO al_capability_declared (device_id, runner_id, name, scope, metadata, reported_at)
VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)
ON CONFLICT (device_id, runner_id, name, scope)
DO UPDATE SET reported_at = EXCLUDED.reported_at
RETURNING *;
`,

  insertCapabilityGrant: `
INSERT INTO al_capability_grant (
  id,
  domain,
  device_id,
  runner_id,
  capability,
  grant_status,
  granted_by,
  granted_at
) VALUES (
  $1,
  $2,
  $3,
  $4,
  $5,
  'GRANTED',
  $6,
  $7
)
ON CONFLICT (domain, device_id, runner_id, capability)
WHERE grant_status = 'GRANTED' AND revoked_at IS NULL
DO UPDATE SET granted_at = al_capability_grant.granted_at
RETURNING *;
`,

  insertWorkdirGrant: `
INSERT INTO al_workdir_grant (
  id,
  domain,
  device_id,
  path_prefix,
  access_mode,
  created_at
) VALUES (
  $1,
  $2,
  $3,
  $4,
  $5,
  $6
)
ON CONFLICT (domain, device_id, path_prefix, access_mode)
WHERE revoked_at IS NULL
DO UPDATE SET created_at = al_workdir_grant.created_at
RETURNING *;
`,

  findDeviceById: `
SELECT row_to_json(d) AS device
FROM al_device d
WHERE d.id = $1;
`,

  heartbeatDevice: `
UPDATE al_device
SET status = 'ONLINE',
    last_auth_at = $2,
    last_heartbeat_at = $2,
    updated_at = $2
WHERE id = $1
  AND status <> 'REVOKED'
RETURNING *;
`,

  findRunnerById: `
SELECT row_to_json(runner_with_caps) AS runner
FROM (
  SELECT
    r.*,
    COALESCE(json_agg(cd.name ORDER BY cd.name) FILTER (WHERE cd.name IS NOT NULL), '[]'::json) AS capabilities
  FROM al_runner r
  LEFT JOIN al_capability_declared cd ON cd.device_id = r.device_id AND cd.runner_id = r.id
  WHERE r.id = $1
  GROUP BY r.id
) runner_with_caps;
`,

  findDispatchCandidates: `
SELECT row_to_json(r) AS run, row_to_json(t) AS task
FROM al_run r
JOIN al_task t ON t.id = r.task_id
WHERE r.domain = $1
  AND r.status = 'QUEUED'
ORDER BY r.created_at ASC, r.id ASC
LIMIT $2;
`,

  leaseSpecificQueuedRun: `
WITH candidate_run AS (
  SELECT r.id, r.task_id, r.domain
  FROM al_run r
  JOIN al_device d ON d.id = $2 AND d.domain = r.domain
  JOIN al_runner runner ON runner.id = $3 AND runner.device_id = d.id
  WHERE r.id = $1
    AND r.domain = $4
    AND r.status = 'QUEUED'
    AND d.status = 'ONLINE'
    AND runner.status = 'online'
    AND NOT EXISTS (
      SELECT 1
      FROM al_run_lease active_lease
      WHERE active_lease.run_id = r.id
        AND active_lease.status IN ${ACTIVE_LEASE_STATUSES_SQL}
    )
  LIMIT 1
  FOR UPDATE OF r SKIP LOCKED
), inserted_lease AS (
  INSERT INTO al_run_lease (id, run_id, domain, device_id, runner_id, status, issued_at, expires_at, created_at, updated_at)
  SELECT $5, c.id, c.domain, $2, $3, 'ISSUED', $6, $7, $6, $6
  FROM candidate_run c
  RETURNING *
), updated_run AS (
  UPDATE al_run r
  SET status = 'LEASED', current_lease_id = l.id, policy_decision_id = $8, updated_at = $6, version = r.version + 1
  FROM inserted_lease l
  WHERE r.id = l.run_id
    AND r.status = 'QUEUED'
    AND r.current_lease_id IS NULL
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = 'RUNNING', updated_at = $6
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

  findActiveCapabilityGrantsForRunner: `
SELECT *
FROM al_capability_grant
WHERE domain = $1
  AND device_id = $2
  AND runner_id = $3
  AND capability = ANY($4::text[])
  AND grant_status = 'GRANTED'
  AND revoked_at IS NULL;
`,

  listCapabilityGrantsForDevice: `
SELECT *
FROM al_capability_grant
WHERE device_id = $1
ORDER BY granted_at ASC, id ASC;
`,

  revokeCapabilityGrant: `
UPDATE al_capability_grant
SET grant_status = 'REVOKED',
    revoked_at = COALESCE(revoked_at, $2)
WHERE id = $1
RETURNING *;
`,

  findActiveWorkdirGrantsForDevice: `
SELECT *
FROM al_workdir_grant
WHERE domain = $1
  AND device_id = $2
  AND revoked_at IS NULL
ORDER BY length(path_prefix) DESC;
`,

  listWorkdirGrantsForDevice: `
SELECT *
FROM al_workdir_grant
WHERE device_id = $1
ORDER BY created_at ASC, id ASC;
`,

  revokeWorkdirGrant: `
UPDATE al_workdir_grant
SET revoked_at = COALESCE(revoked_at, $2)
WHERE id = $1
RETURNING *;
`,

  insertPolicyDecision: `
INSERT INTO al_policy_decision (
  id,
  domain,
  task_id,
  run_id,
  device_id,
  runner_id,
  input,
  decision,
  reason,
  created_at
) VALUES (
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  $7::jsonb,
  $8,
  $9,
  $10
)
RETURNING *;
`,

  revokeDevice: `
UPDATE al_device
SET status = 'REVOKED',
    revoked_at = COALESCE(revoked_at, $2),
    updated_at = $2
WHERE id = $1
RETURNING *;
`,

  cancelActiveLeasesForDevice: `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, l.id AS lease_id
  FROM al_run_lease l
  JOIN al_run r ON r.id = l.run_id
  JOIN al_task t ON t.id = r.task_id AND t.current_run_id = r.id
  WHERE l.device_id = $1
    AND l.status IN ${ACTIVE_LEASE_STATUSES_SQL}
    AND r.current_lease_id = l.id
    AND r.status IN ('LEASED', 'RUNNING')
    AND t.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
  FOR UPDATE OF r, l, t
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'CANCELLED', cancelled_at = $2, expire_reason = $3, updated_at = $2, version = l.version + 1
  FROM target
  WHERE l.id = target.lease_id
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET status = 'CANCELLED', finished_at = $2, updated_at = $2, version = r.version + 1
  FROM target
  WHERE r.id = target.run_id
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = 'CANCELLED', updated_at = $2
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

  renewLease: `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, l.id AS lease_id, l.device_id
  FROM al_run r
  JOIN al_run_lease l ON l.id = $1 AND l.run_id = r.id
  WHERE r.status = 'RUNNING'
    AND r.current_lease_id = l.id
    AND l.status IN ('ACKED', 'RENEWED')
  FOR UPDATE OF r, l
), updated_lease AS (
  UPDATE al_run_lease l
  SET status = 'RENEWED', renewed_at = $2, expires_at = $3, updated_at = $2, version = l.version + 1
  FROM target
  WHERE l.id = target.lease_id
  RETURNING l.*
), updated_run AS (
  UPDATE al_run r
  SET updated_at = $2, version = r.version + 1
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
), inserted_control_action AS (
  INSERT INTO al_control_action (
    id,
    domain,
    device_id,
    run_id,
    lease_id,
    action_type,
    status,
    reason,
    created_at,
    updated_at
  )
  SELECT $4, l.domain, l.device_id, l.run_id, l.id, 'cancel_run', 'PENDING', COALESCE(l.expire_reason, $3), $2, $2
  FROM updated_lease l
  ON CONFLICT (device_id, action_type, lease_id)
  DO UPDATE SET status = 'PENDING',
                reason = EXCLUDED.reason,
                acknowledged_at = NULL,
                updated_at = EXCLUDED.updated_at
  RETURNING *
)
SELECT row_to_json(t) AS task, row_to_json(r) AS run, row_to_json(l) AS lease, row_to_json(a) AS control_action
FROM updated_task t
LEFT JOIN updated_run r ON r.task_id = t.id
LEFT JOIN updated_lease l ON l.run_id = r.id
LEFT JOIN inserted_control_action a ON a.lease_id = l.id;
`,

  listControlActionsForDevice: `
SELECT row_to_json(a) AS control_action
FROM al_control_action a
WHERE a.device_id = $1
  AND a.status = 'PENDING'
ORDER BY a.created_at ASC, a.id ASC
LIMIT $2;
`,

  ackControlAction: `
WITH target AS (
  SELECT a.*
  FROM al_control_action a
  WHERE a.id = $1
    AND a.device_id = $2
  FOR UPDATE
), updated_action AS (
  UPDATE al_control_action a
  SET status = 'ACKED',
      acknowledged_at = COALESCE(a.acknowledged_at, $3),
      updated_at = $3
  FROM target
  WHERE a.id = target.id
  RETURNING a.*
)
SELECT row_to_json(a) AS control_action
FROM updated_action a;
`,

  listRecoverableRunsForDevice: `
SELECT row_to_json(l) AS lease, row_to_json(r) AS run, row_to_json(t) AS task
FROM al_run_lease l
JOIN al_run r ON r.id = l.run_id
JOIN al_task t ON t.id = r.task_id
WHERE l.device_id = $1
  AND l.status IN ${ACTIVE_LEASE_STATUSES_SQL}
  AND r.current_lease_id = l.id
  AND r.status IN ('LEASED', 'RUNNING')
ORDER BY l.updated_at ASC, l.id ASC
LIMIT $2;
`,

  findRecoverableLeaseForDecision: `
SELECT row_to_json(l) AS lease, row_to_json(r) AS run
FROM al_run_lease l
JOIN al_run r ON r.id = l.run_id
WHERE l.id = $1
  AND l.device_id = $2
  AND l.status IN ${ACTIVE_LEASE_STATUSES_SQL}
  AND r.current_lease_id = l.id
  AND r.status IN ('LEASED', 'RUNNING')
LIMIT 1;
`,

  recoverContinue: `
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
), updated_run AS (
  UPDATE al_run r
  SET status = 'RUNNING', started_at = COALESCE(r.started_at, $3), updated_at = $3, version = r.version + 1
  FROM target
  WHERE r.id = target.run_id
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = 'RUNNING', updated_at = $3
  FROM updated_run r
  WHERE t.id = r.task_id
  RETURNING t.*
)
SELECT row_to_json(l) AS lease, row_to_json(r) AS run, row_to_json(t) AS task
FROM updated_lease l
JOIN updated_run r ON r.id = l.run_id
JOIN updated_task t ON t.id = r.task_id;
`,

  recoverDiscard: `
WITH target AS (
  SELECT r.id AS run_id, r.task_id, l.id AS lease_id
  FROM al_run_lease l
  JOIN al_run r ON r.id = l.run_id
  WHERE l.id = $1
    AND l.device_id = $2
    AND l.status IN ${ACTIVE_LEASE_STATUSES_SQL}
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
  SET status = 'TIMED_OUT', finished_at = $4, updated_at = $4, version = r.version + 1
  FROM target
  WHERE r.id = target.run_id
  RETURNING r.*
), updated_task AS (
  UPDATE al_task t
  SET status = 'FAILED', updated_at = $4
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
} as const;

export type PostgreSqlStatementName = keyof typeof PostgreSqlStatements;

export function getPostgreSqlStatement(name: PostgreSqlStatementName): string {
  return PostgreSqlStatements[name];
}
