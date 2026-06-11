# M1 task status matrix

This document maps the reviewed M1 technical-design tasks (`AL-TD-*`) to the repository state. It prevents the first executable vertical slice from being misread as a single `AL-TD-001` implementation.

## Status definitions

| Status | Meaning |
| --- | --- |
| Done | The task has a repo artifact, automated checks, and no known M1-blocking gap for the task scope. |
| Partial | A useful slice exists, but one or more required pieces remain before the task is complete. |
| Not started | No meaningful implementation exists beyond schema placeholders or planning text. |

## Current mapping

| Task | Design scope | Current status | Repository evidence | Remaining M1 work |
| --- | --- | --- | --- | --- |
| AL-TD-001 | Project skeleton, config, PostgreSQL migration, `domain` / `network_scope` baseline fields | Done | `f656f10` initialized repo/CI/config/server/migration; `1647109` kept the migration aligned with M1 naming; `.github/workflows/ci.yml`; `src/config/index.ts`; `migrations/0001_initial.sql`; `test/migration.test.ts` | Real PostgreSQL runtime/repository belongs to a later task, not AL-TD-001. |
| AL-TD-002 | Canonical enums and Task / Run / Lease / Device state matrix | Partial | `src/domain/status.ts`; `test/status.test.ts`; in-memory transitions in `src/control-plane/in-memory.ts`; PostgreSQL statement contracts in `src/db/postgres-statements.ts` | DB-level enum/check usage exists in migration and SQL contracts; `src/db/postgres-repository.ts` now maps rowCount / replay / conflict cases to typed domain errors. Still missing real PostgreSQL client wiring, live DSN tests, and a standalone state-transition executor. |
| AL-TD-003 | Device / Runner / capability declared/grant and workdir grant | Partial | `al_device`, `al_runner`, `al_capability_declared`, `al_capability_grant`, `al_workdir_grant`; `src/domain/policy.ts`; in-memory capability/workdir grants; pull-time policy decisions; HTTP register-time grant seeding; policy SQL lookup contracts; AL_CAPABILITY_DENIED / AL_WORKDIR_DENIED tests | Still missing live PostgreSQL policy repository wiring, explicit grant management APIs, revoke/update APIs, and scheduler-level policy blocking semantics. |
| AL-TD-004 | Task API + Main Agent MVP + `task_spec` | Partial | `POST /api/v1/tasks`; `GET /api/v1/tasks/:taskId`; task idempotency; M1 inline Main Agent shortcut documented in `STATE_TRANSITIONS.create_task`; `al_task.idempotency_signature`; `findTaskByIdempotencyKey`; `createTaskWithInitialRun` | Standalone Main Agent / TaskSpecBuilder component is not implemented; live repository adapter still needs to map idempotency signature mismatches to `AL_IDEMPOTENCY_CONFLICT`. |
| AL-TD-005 | Run + `al_run_lease` + active lease partial unique index + pull/ack/renew | Partial | `al_run`, `al_run_lease`, `uq_al_run_lease_active`; `agentlet/pull`; `agentlet/ack`; lease tests; `src/db/transaction.ts`; `src/db/postgres-statements.ts`; `scripts/db-smoke.mjs`; `test/postgres-statements.test.ts`; `test/transaction.test.ts`; SQL contracts for lease, ack, progress, complete, replay, retry attempt, expiry, and cancel; `uq_al_run_task_attempt` DB backstop | `src/db/postgres-repository.ts` implements a dependency-free repository adapter over a checked-out `SqlClient`, including task idempotency, lease, ack, progress, complete replay, retry attempt, expiry, and cancel typed mappings. Remaining gaps: `renew` endpoint, concrete `pg` connection/pool wiring, and real concurrent pull / unique violation tests against a live DSN. |
| AL-TD-006 | `control_actions` / poll + recover + cancel | Partial | State matrix has planning entries for recover/cancel/revoke; `cancelTask` SQL contract covers external task cancel state updates | No HTTP protocol, control_actions polling, or runtime recover implementation yet. |
| AL-TD-006B | Retry watcher, `attempt_no` / `retry_count` / `max_retries`, late-complete protection | Partial | `src/domain/retry.ts`; `completeRun(FAILED)` creates a new queued run attempt when retryable; `createRetryRunAttempt` and `expireActiveLease` SQL contracts; tests cover retryable failure and SQL retry/expiry predicates | Repository complete/expire paths now create retry attempts in the same transaction when retry policy allows. Live lease-expiry watcher, run-timeout watcher, and real late-complete race tests remain. |
| AL-TD-007 | Codex Runner Adapter | Not started | None | Implement agentlet-side Codex adapter and local execution contract. |
| AL-TD-008 | Telegram Channel Adapter and progress throttling | Not started | None | Implement Telegram inbound/outbound, idempotency key mapping, and progress delivery policy. |
| AL-TD-009 | `run_event` / artifact / error taxonomy | Partial | `al_run_event`, `al_artifact`; in-memory progress events; snake_case run-event DTOs | Artifact upload, error taxonomy, retention/replay policy, and separate system/audit event stream remain. |

## Slice labels

- `f656f10 Establish Agentlink M1 as an independent GitHub project skeleton` = `M1-Init / AL-TD-001` baseline.
- `1647109 Make Agentlink M1 control-plane semantics executable` = `M1-S1 executable control-plane slice`, spanning parts of `AL-TD-002`, `AL-TD-004`, `AL-TD-005`, `AL-TD-006B`, and `AL-TD-009`.

## AL-TD-001 acceptance checklist

| Check | Evidence | Status |
| --- | --- | --- |
| GitHub repo, local skeleton, and CI exist | `git@github.com:whiteParachute/agentlink.git`, `.github/workflows/ci.yml` | Done |
| Basic config exists | `.env.example`, `src/config/index.ts` | Done |
| Basic server exists | `/healthz`, `/readyz`, `/api/v1/meta` in `src/server.ts` | Done |
| Raw PostgreSQL migration baseline exists | `migrations/0001_initial.sql` | Done |
| `domain` baseline exists | `al_domain`, `domain` columns across core tables | Done |
| `network_scope` baseline exists | `al_device.network_scope` and tests | Done |
| Migration invariants are tested | `test/migration.test.ts` | Done |

## Next recommended order

1. Finish the remaining PostgreSQL runtime wiring for AL-TD-002 / AL-TD-005 when a concrete Postgres client/DSN strategy is approved: connect `PostgreSqlRepository` to a checked-out client/pool wrapper and add real concurrent pull tests.
2. Add AL-TD-003 grant management/revoke APIs or wire the static evaluator into the future live PostgreSQL repository path.
3. Implement AL-TD-006 control actions / cancel / recover.
4. Implement AL-TD-007 Codex Runner Adapter.
5. Implement AL-TD-008 Telegram adapter and then run the first real end-to-end M1 loop.

## 2026-06-11 AL-TD-002/005 repository-spike update

- Added `src/db/transaction.ts` as the repository transaction boundary abstraction.
- Added `src/db/postgres-statements.ts` to freeze the M1 PostgreSQL contracts for queued-run leasing, ack accept/reject, progress append, terminal complete, and terminal-complete replay.
- Added `scripts/db-smoke.mjs` and `npm run db:smoke`; it is optional without `AGENTLINK_DATABASE_URL` and applies the migration inside a temporary schema when a DSN + `psql` are available.
- Added tests for transaction commit/rollback, SQL row-lock / active-lease predicates, ACKED/RENEWED execution guards, terminal replay scoping, and `terminal_payload_hash` migration persistence.
- Kept the task status as Partial because there is still no live PostgreSQL repository adapter, no real concurrent database test, and no `lease/renew` endpoint.

## 2026-06-11 repository-contract parity update

- Added `al_task.idempotency_signature` so PostgreSQL-backed task creation can detect same-key / different-payload conflicts like the in-memory control plane.
- Added SQL contracts for `findTaskByIdempotencyKey`, `createTaskWithInitialRun`, `createRetryRunAttempt`, `expireActiveLease`, and `cancelTask`.
- Added `uq_al_run_task_attempt` and `t.current_run_id = previous.id` retry guard so stale terminal runs cannot create duplicate attempts or overwrite the current run.
- Tightened `leaseNextQueuedRun` to `FOR UPDATE OF r SKIP LOCKED` and removed the unused `al_task` join from the candidate CTE.
- Documented that `withTransaction` must receive a single checked-out client, not a pool object.
- Kept the scope dependency-free; these are repository contracts and invariants, not a live PostgreSQL adapter.


## 2026-06-11 PostgreSQL repository adapter update

- Added `src/db/postgres-repository.ts`, a dependency-free adapter over the existing `SqlClient` contract. It is intentionally not tied to `pg`; callers must supply a checked-out PostgreSQL client that satisfies `SqlClient`.
- Added typed rowCount/error mapping for task idempotency, active-lease-scoped progress replay/conflict/expired-lease classification, terminal complete replay, retry attempt creation, lease expiry, and cancel.
- Kept retry creation inside the same transaction as `completeRun(FAILED)` / `expireActiveLease` when policy allows retry, preserving the Draft 3 “old terminal Run + new Run attempt” model.
- Added `test/postgres-repository.test.ts` for repository mapping and transaction sequence invariants. Test count increased to 44.
- Remaining gaps are runtime wiring, `pg` dependency / pool adapter decision, real `AGENTLINK_DATABASE_URL` integration tests, `lease/renew`, and concurrent `SKIP LOCKED` / partial unique index tests.

## 2026-06-11 AL-TD-003 policy/grant evaluator update

- Added `src/domain/policy.ts` to evaluate static M1 dispatch policy inputs: network_scope, declared/supported/granted capabilities, and workdir grant coverage.
- Added in-memory capability grant and workdir grant records. Device registration can seed static grants for M1 bootstrap, while missing grants deny pull with `AL_CAPABILITY_DENIED` or `AL_WORKDIR_DENIED`.
- Added pull-time policy decision recording and `run.policyDecisionId` linkage for allowed dispatches.
- Added PostgreSQL contract statements and active lookup indexes for capability/workdir grants plus policy decision insertion.
- Added unit and HTTP tests for missing capability grants, missing workdir grants, network_scope mismatch, workdir prefix matching, and grant SQL/migration invariants. Test count increased to 52.
- Remaining gaps are live PostgreSQL policy repository wiring, explicit grant/revoke APIs, and durable scheduler behavior for policy-denied queued runs.
