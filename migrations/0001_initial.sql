-- Agentlink M1 initial schema spike.
-- Source of truth: Agentlink M1 technical design Draft 3.

BEGIN;

CREATE TYPE al_domain AS ENUM ('personal', 'work');
CREATE TYPE al_task_status AS ENUM ('CREATED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED');
CREATE TYPE al_run_status AS ENUM ('QUEUED', 'LEASED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE al_lease_status AS ENUM ('ISSUED', 'ACKED', 'RENEWED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REJECTED');
CREATE TYPE al_device_status AS ENUM ('REGISTERED', 'ONLINE', 'OFFLINE', 'SUSPENDED', 'REVOKED');
CREATE TYPE al_grant_status AS ENUM ('GRANTED', 'REVOKED');

CREATE TABLE al_task (
  id uuid PRIMARY KEY,
  domain al_domain NOT NULL DEFAULT 'personal',
  source text NOT NULL,
  source_ref text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  task_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  status al_task_status NOT NULL DEFAULT 'CREATED',
  current_run_id uuid,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries integer NOT NULL DEFAULT 1 CHECK (max_retries >= 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, idempotency_key)
);

CREATE TABLE al_device (
  id uuid PRIMARY KEY,
  domain al_domain NOT NULL DEFAULT 'personal',
  display_name text NOT NULL,
  token_hash text NOT NULL,
  network_scope text NOT NULL DEFAULT 'personal',
  owner_user_id text NOT NULL,
  trust_level text NOT NULL DEFAULT 'standard' CHECK (trust_level IN ('untrusted', 'standard', 'trusted')),
  status al_device_status NOT NULL DEFAULT 'REGISTERED',
  revoked_at timestamptz,
  last_auth_at timestamptz,
  last_heartbeat_at timestamptz,
  agentlet_version text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, token_hash)
);

CREATE TABLE al_runner (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES al_device(id),
  runner_type text NOT NULL,
  runner_version text,
  model text,
  status text NOT NULL DEFAULT 'online',
  max_concurrency integer NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE al_policy_decision (
  id uuid PRIMARY KEY,
  domain al_domain NOT NULL DEFAULT 'personal',
  task_id uuid REFERENCES al_task(id),
  run_id uuid,
  device_id uuid REFERENCES al_device(id),
  runner_id uuid REFERENCES al_runner(id),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision text NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE al_run (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES al_task(id),
  domain al_domain NOT NULL DEFAULT 'personal',
  status al_run_status NOT NULL DEFAULT 'QUEUED',
  attempt_no integer NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  retry_of_run_id uuid REFERENCES al_run(id),
  instruction jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_decision_id uuid REFERENCES al_policy_decision(id),
  result jsonb,
  error jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_lease_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  deadline_at timestamptz
);

ALTER TABLE al_task
  ADD CONSTRAINT fk_al_task_current_run
  FOREIGN KEY (current_run_id) REFERENCES al_run(id);

ALTER TABLE al_policy_decision
  ADD CONSTRAINT fk_al_policy_decision_run
  FOREIGN KEY (run_id) REFERENCES al_run(id);

CREATE TABLE al_run_lease (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES al_run(id),
  domain al_domain NOT NULL DEFAULT 'personal',
  device_id uuid NOT NULL REFERENCES al_device(id),
  runner_id uuid NOT NULL REFERENCES al_runner(id),
  status al_lease_status NOT NULL DEFAULT 'ISSUED',
  issued_at timestamptz NOT NULL DEFAULT now(),
  acked_at timestamptz,
  expires_at timestamptz NOT NULL,
  renewed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  expire_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Draft 3 active lease definition: ISSUED / ACKED / RENEWED.
-- This database-level guard is the final backstop for concurrent pull, renew, expire, and recover races.
CREATE UNIQUE INDEX uq_al_run_lease_active
ON al_run_lease(run_id)
WHERE status IN ('ISSUED', 'ACKED', 'RENEWED');

ALTER TABLE al_run
  ADD CONSTRAINT fk_al_run_current_lease
  FOREIGN KEY (current_lease_id) REFERENCES al_run_lease(id);

CREATE TABLE al_capability_declared (
  device_id uuid NOT NULL REFERENCES al_device(id),
  runner_id uuid NOT NULL REFERENCES al_runner(id),
  name text NOT NULL,
  scope text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, runner_id, name, scope)
);

CREATE TABLE al_capability_grant (
  id uuid PRIMARY KEY,
  domain al_domain NOT NULL DEFAULT 'personal',
  device_id uuid NOT NULL REFERENCES al_device(id),
  runner_id uuid NOT NULL REFERENCES al_runner(id),
  capability text NOT NULL,
  grant_status al_grant_status NOT NULL DEFAULT 'GRANTED',
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE al_workdir_grant (
  id uuid PRIMARY KEY,
  domain al_domain NOT NULL DEFAULT 'personal',
  device_id uuid NOT NULL REFERENCES al_device(id),
  path_prefix text NOT NULL,
  access_mode text NOT NULL CHECK (access_mode IN ('read', 'write', 'read_write')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE al_run_event (
  run_id uuid NOT NULL REFERENCES al_run(id),
  seq bigint NOT NULL,
  domain al_domain NOT NULL DEFAULT 'personal',
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  emitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE al_artifact (
  domain al_domain NOT NULL DEFAULT 'personal',
  hash text NOT NULL,
  kind text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  storage_type text NOT NULL CHECK (storage_type IN ('inline', 'ref')),
  uri text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, hash)
);

CREATE TABLE al_audit_log (
  id uuid PRIMARY KEY,
  domain al_domain NOT NULL DEFAULT 'personal',
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  result text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_al_task_domain_status_created ON al_task(domain, status, created_at DESC);
CREATE INDEX idx_al_run_task ON al_run(task_id);
CREATE INDEX idx_al_run_domain_status ON al_run(domain, status);
CREATE INDEX idx_al_run_lease_device_status_expires ON al_run_lease(device_id, status, expires_at);
CREATE INDEX idx_al_device_domain_status ON al_device(domain, status);
CREATE INDEX idx_al_runner_device_status ON al_runner(device_id, status);
CREATE INDEX idx_al_capability_grant_lookup ON al_capability_grant(domain, capability, grant_status);
CREATE INDEX idx_al_workdir_grant_device ON al_workdir_grant(domain, device_id);
CREATE INDEX idx_al_policy_decision_run ON al_policy_decision(run_id);
CREATE INDEX idx_al_audit_log_domain_created ON al_audit_log(domain, created_at DESC);

COMMIT;
