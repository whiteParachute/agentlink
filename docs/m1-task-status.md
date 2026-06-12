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
| AL-TD-002 | Canonical enums and Task / Run / Lease / Device state matrix | Partial | `src/domain/status.ts`; `test/status.test.ts`; in-memory transitions in `src/control-plane/in-memory.ts`; PostgreSQL statement contracts in `src/db/postgres-statements.ts`; `src/control-plane/postgres.ts`; `src/control-plane/port.ts` | DB-level enum/check usage exists in migration and SQL contracts; `src/db/postgres-repository.ts` maps rowCount / replay / conflict cases to typed domain errors; server now has an opt-in PostgreSQL control-plane mode. Still missing live DSN tests, concurrent DB verification, and a standalone state-transition executor. |
| AL-TD-003 | Device / Runner / capability declared/grant and workdir grant | Partial | `al_device`, `al_runner`, `al_capability_declared`, `al_capability_grant`, `al_workdir_grant`; `src/domain/policy.ts`; in-memory capability/workdir grants; pull-time policy decisions; HTTP register-time grant seeding; policy SQL lookup contracts; PostgreSQL pull path now evaluates static grants before leasing; minimal capability/workdir grant list/create/revoke APIs; device revoke cascade API | Still missing richer grant update/audit APIs, runner capability report refresh APIs, and durable scheduler behavior for policy-denied queued runs. |
| AL-TD-004 | Task API + Main Agent MVP + `task_spec` | Partial | `POST /api/v1/tasks`; `GET /api/v1/tasks/:taskId`; task idempotency; M1 inline Main Agent shortcut documented in `STATE_TRANSITIONS.create_task`; `al_task.idempotency_signature`; `findTaskByIdempotencyKey`; `createTaskWithInitialRun` | Standalone Main Agent / TaskSpecBuilder component is not implemented; current M1 shortcut still creates `task_spec` inline. |
| AL-TD-005 | Run + `al_run_lease` + active lease partial unique index + pull/ack/renew | Partial | `al_run`, `al_run_lease`, `uq_al_run_lease_active`; `agentlet/pull`; `agentlet/ack`; `agentlet/lease/renew`; lease tests; `src/db/transaction.ts`; `src/db/postgres-statements.ts`; `src/db/postgres-repository.ts`; `src/db/pg-client.ts`; `src/control-plane/postgres.ts`; `scripts/db-smoke.mjs`; PostgreSQL server mode config | Repository now supports task/device/run/lease/event lookup, device register/auth/heartbeat, policy-before-lease dispatch, opt-in server mode via `AGENTLINK_STORAGE=postgres`, lease renew, and control/recover lookup contracts. Remaining gap: real concurrent pull / renew / unique violation tests against a live DSN. |
| AL-TD-006 | `control_actions` / poll + recover + cancel | Partial | `POST /api/v1/tasks/:taskId/cancel`; `POST /api/v1/agentlet/control/poll`; `POST /api/v1/agentlet/control/ack`; `POST /api/v1/agentlet/recover`; `POST /api/v1/agentlet/recover/decision`; `POST /api/v1/devices/:deviceId/revoke`; `al_control_action`; in-memory control actions; PostgreSQL `cancelTask`, `listControlActionsForDevice`, `ackControlAction`, `listRecoverableRunsForDevice`, `recoverContinue`, `recoverDiscard`, `revokeDevice`; HTTP and repository tests | Minimal M1 control protocol now covers cancel, poll, ack retention, renew envelope, recover continue, recover discard, and device revoke cascade. Remaining gaps: real agentlet consumption, live DSN validation, and long-term control-action retention cleanup policy. |
| AL-TD-006B | Retry watcher, `attempt_no` / `retry_count` / `max_retries`, late-complete protection | Partial | `src/domain/retry.ts`; `completeRun(FAILED)` creates a new queued run attempt when retryable; `createRetryRunAttempt` and `expireActiveLease` SQL contracts; tests cover retryable failure and SQL retry/expiry predicates | Repository complete/expire paths now create retry attempts in the same transaction when retry policy allows. Live lease-expiry watcher, run-timeout watcher, and real late-complete race tests remain. |
| AL-TD-007 | Codex Runner Adapter | Partial | `src/agentlet/runner.ts`; `src/agentlet/codex-runner.ts`; `test/codex-runner.test.ts`; README status update | Minimal agentlet-side runner contract and Codex CLI adapter skeleton exist, including command construction, workspace root validation, local env allowlist, stdout/stderr/final progress mapping, non-zero failure, timeout/cancel handling, and fake-runner tests. Still missing a long-running agentlet daemon that consumes leases, real Codex CLI smoke on claw-tenc, local process cleanup hardening, and integration with control-plane renew/progress/complete loop. |
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

1. Run live PostgreSQL DSN smoke and add real concurrent pull / renew / unique violation tests for the new `AGENTLINK_STORAGE=postgres` mode.
2. Finish AL-TD-003 remaining grant/report polish only if needed before runner integration.
3. Wire the AL-TD-007 Codex Runner Adapter into a minimal long-running agentlet daemon loop on claw-tenc.
4. Implement AL-TD-008 Telegram adapter and then run the first real end-to-end M1 loop.
5. Add retention cleanup / observability for pending and acknowledged control actions after the real agentlet starts consuming them.

## 2026-06-11 AL-TD-002/005 repository-spike update

- Added `src/db/transaction.ts` as the repository transaction boundary abstraction.
- Added `src/db/postgres-statements.ts` to freeze the M1 PostgreSQL contracts for queued-run leasing, ack accept/reject, progress append, terminal complete, and terminal-complete replay.
- Added `scripts/db-smoke.mjs` and `npm run db:smoke`; it is optional without `AGENTLINK_DATABASE_URL` and applies the migration through the `pg` runtime driver inside a temporary schema when a DSN is available.
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
- Remaining gaps are full server runtime wiring, real `AGENTLINK_DATABASE_URL` integration tests, `lease/renew`, and concurrent `SKIP LOCKED` / partial unique index tests. The `pg` dependency / pool adapter decision has been approved.

## 2026-06-11 AL-TD-003 policy/grant evaluator update

- Added `src/domain/policy.ts` to evaluate static M1 dispatch policy inputs: network_scope, declared/supported/granted capabilities, and workdir grant coverage.
- Added in-memory capability grant and workdir grant records. Device registration can seed static grants for M1 bootstrap, while missing grants deny pull with `AL_CAPABILITY_DENIED` or `AL_WORKDIR_DENIED`.
- Added pull-time policy decision recording and `run.policyDecisionId` linkage for allowed dispatches.
- Added PostgreSQL contract statements and active lookup indexes for capability/workdir grants plus policy decision insertion.
- Added unit and HTTP tests for missing capability grants, missing workdir grants, network_scope mismatch, workdir prefix matching, and grant SQL/migration invariants. Test count increased to 52.
- Remaining gaps are live PostgreSQL policy repository wiring, explicit grant/revoke APIs, and durable scheduler behavior for policy-denied queued runs.


## 2026-06-11 PostgreSQL runtime dependency update

- Added `pg` as the runtime PostgreSQL driver and `@types/pg` for TypeScript.
- Added `src/db/pg-client.ts` with `PgSqlClient` and `PgRuntime`, plus `src/db/postgres-runtime.ts` to bind `PostgreSqlRepository` to a checked-out runtime client; the runtime always checks out one pool client before exposing it as `SqlClient`, preserving the transaction boundary required by `withTransaction`.
- Added PostgreSQL runtime settings to `.env.example` and `src/config/index.ts`: `AGENTLINK_DATABASE_URL`, pool max, idle timeout, and connection timeout.
- Updated `scripts/db-smoke.mjs` to use the `pg` runtime driver instead of shelling out to `psql`. The no-DSN path still skips successfully.
- Added config and pg-runtime adapter tests. Test count increased to 58.
- Remaining gaps: server boot still defaults to the in-memory control plane; live repository mode, live DSN repository tests, and concurrent lease tests are still pending.

## 2026-06-11 live PostgreSQL server wiring update

- Added `AGENTLINK_STORAGE=memory|postgres`. The default remains `memory`; `postgres` requires `AGENTLINK_DATABASE_URL`.
- Added `src/control-plane/port.ts` so the HTTP server depends on an async control-plane port instead of an in-memory concrete class.
- Added `src/control-plane/postgres.ts`, wiring HTTP Task / Device / Agentlet calls to `PostgreSqlRepository` through `PgRuntime` checked-out clients.
- Extended `PostgreSqlRepository` to cover device registration, device auth/heartbeat, task/run/lease/event lookup, policy-before-lease dispatch, and static grant/workdir decision recording before `leaseSpecificQueuedRun`.
- Added SQL contracts and tests for register/auth/heartbeat, dispatch candidate lookup, policy decision insertion, policy-denied no-lease behavior, and configured server storage mode. Test count increased to 66.
- Remaining gaps: no live `AGENTLINK_DATABASE_URL` run in this environment, no real concurrent `SKIP LOCKED` / partial unique index test yet, no `lease/renew`, and no control_actions / recover / cancel HTTP protocol yet.

## 2026-06-11 AL-TD-006 minimal control protocol update

- Added minimal task cancellation and agentlet control polling:
  - `POST /api/v1/tasks/:taskId/cancel`
  - `POST /api/v1/agentlet/control/poll`
  - `POST /api/v1/agentlet/recover`
- Added `ControlActionRecord` and `RecoverableRunRecord` domain contracts. External DTOs stay snake_case: `control_actions`, `run_id`, `lease_id`, `recoverable_runs`.
- In memory mode, canceling a running task moves Task / Run / active Lease to `CANCELLED`, emits a `cancel_run` control action, and removes the run from recoverable active leases.
- In PostgreSQL repository contracts, `listControlActionsForDevice` derives cancel actions from cancelled leases, while `listRecoverableRunsForDevice` only returns active leases for `LEASED` / `RUNNING` runs.
- Added unit / HTTP / repository / SQL contract tests. Test count increased to 70.
- Remaining gaps were control action ack/retention, `lease/renew`, recover decisions, device revoke cascade, real agentlet consumption, and live DSN validation. The next update closes the first three.

## 2026-06-11 AL-TD-005/006 control renew and recovery decision update

- Added `POST /api/v1/agentlet/lease/renew`; renew only accepts an executing lease (`ACKED` / `RENEWED` + `RUNNING`) and returns the current control envelope.
- Added durable `al_control_action` schema for pending/acknowledged control actions, plus `POST /api/v1/agentlet/control/ack` so `cancel_run` actions are not replayed forever after agentlet acknowledgement.
- Added `POST /api/v1/agentlet/recover/decision` with `continue` and `discard` decisions. `continue` renews the lease and keeps the run `RUNNING`; `discard` expires the lease, marks the old run `TIMED_OUT`, and creates a new retry attempt when retry policy allows it.
- Wired the same semantics through in-memory mode, PostgreSQL statement contracts, repository adapter, PostgreSQL-backed control plane, and HTTP DTOs.
- Converted `README.md` to a concise Chinese project introduction as requested.
- Test count increased to 75. Remaining gaps are live PostgreSQL DSN/concurrency validation, device revoke cascade API, real agentlet daemon consumption, Codex Runner Adapter, and Telegram Adapter.

## 2026-06-12 AL-TD-003 grant management and device revoke update

- Added minimal capability grant management APIs: list/create active grant by device and revoke by grant id.
- Added minimal workdir grant management APIs: list/create active grant by device and revoke by grant id.
- Added device revoke cascade API. Revocation marks the device `REVOKED`, blocks future agentlet auth, and cancels current active lease / in-flight run / current task for that device.
- Wired the same semantics through in-memory mode, PostgreSQL statement contracts, repository adapter, PostgreSQL-backed control plane, and HTTP DTOs.
- Added unit / HTTP / repository / SQL contract tests. Test count increased to 84.
- Remaining gaps are richer grant update/audit surfaces, runner capability report refresh, live DSN validation, real agentlet consumption, Codex Runner Adapter, and Telegram Adapter.


## 2026-06-12 AL-TD-007 Codex Runner Adapter skeleton update

- Added `src/agentlet/runner.ts` as the agentlet-side local runner contract. It defines `RunnerAdapter`, `RunnerRunInput`, `RunnerEvent`, `RunnerResult`, and a helper to convert runner events into agentlet progress payloads.
- Added `src/agentlet/codex-runner.ts` with a minimal Codex CLI adapter skeleton. The adapter builds current-CLI-compatible `codex --ask-for-approval <policy> exec --json --cd <workspace>` commands, enforces absolute workspace paths under configured allowed roots, passes only allowlisted local environment variables plus explicit local overrides, and supports `AbortSignal` / timeout boundaries.
- Runner progress sequence is local to the agentlet progress stream: lifecycle, stdout, stderr, error, and final events are emitted with monotonically increasing `seq`; control-plane system/audit events remain separate.
- Added fake command-runner tests for command construction, workspace validation, env allowlist, stdout/stderr progress mapping, successful completion, non-zero failure, and external cancel. Tests do not invoke a real Codex CLI.
- README now lists the Codex Runner Adapter as a skeleton, not as a deployable daemon. Remaining gaps are real agentlet daemon wiring, real Codex CLI device smoke, process cleanup hardening, Telegram Adapter, and end-to-end M1 validation.

## 2026-06-12 memory-first M1 transition (AL-M1-001)

The Agentlink product direction was rewritten to a **memory-first multi-entry Agent collaboration and execution-routing system** (new PRD `HJ7gdnTcDoCx1HxCyRzcr2zyngb`, revision 53). The `AL-TD-*` matrix above is **not** the completion measure of the new PRD's memory-first main line. It now describes the **execution substrate** (Task / Run / Lease / Device / Runner / Policy / Grant / Agentlet / Codex Runner) that the memory-first M1 reuses, defers, or adjusts — not the new Entry / SourceEvent / Session / Memory / Main Agent main line.

- The `AL-TD-*` tasks are **not deprecated**; they are reclassified as execution substrate for memory-first M1.
- The memory-first M1 main line is tracked by the new `AL-M1-*` slices and `AL-TD-MEM-* / AL-TD-INGRESS-* / AL-TD-WORKER-*` tasks in the new PRD, not by this matrix.
- AL-M1-001 (this slice, docs-only) records the reuse boundary in [`docs/m1-control-plane-reuse-boundary.md`](./m1-control-plane-reuse-boundary.md), classifying each control-plane object as Reuse / Adjust / Defer / Keep / Not-in-M1.
- Reading guidance: a `Partial` / `Done` status in the `AL-TD-*` matrix only reflects execution-substrate readiness; it does not imply any memory-first capability (Entry/SourceEvent/Session/Memory) exists yet. No memory / source_event / session tables, entities, or APIs exist in the repo at HEAD `e0c9117`.

See `docs/m1-control-plane-reuse-boundary.md` for the per-object classification, prohibited extensions, and the explicit "must not start in M1" list (MemoryBridge, work/personal interop, legacy system import, AgentDock/happyclaw/Keyclaw/Hermes runtime, multi-MainUser, Telegram main-line E2E, production daemon / multi-device fallback).
