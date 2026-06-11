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
| AL-TD-002 | Canonical enums and Task / Run / Lease / Device state matrix | Partial | `src/domain/status.ts`; `test/status.test.ts`; in-memory transitions in `src/control-plane/in-memory.ts`; PostgreSQL statement contracts in `src/db/postgres-statements.ts` | DB-level enum/check usage exists in migration and SQL contracts, but no live PostgreSQL repository adapter or state-transition executor yet. |
| AL-TD-003 | Device / Runner / capability declared/grant and workdir grant | Partial | `al_device`, `al_runner`, `al_capability_declared`, `al_capability_grant`, `al_workdir_grant`; device register + runner capability in `InMemoryControlPlane` | Runtime grant evaluation and workdir grant enforcement are not implemented. |
| AL-TD-004 | Task API + Main Agent MVP + `task_spec` | Partial | `POST /api/v1/tasks`; `GET /api/v1/tasks/:taskId`; task idempotency; M1 inline Main Agent shortcut documented in `STATE_TRANSITIONS.create_task` | Standalone Main Agent / TaskSpecBuilder component is not implemented. |
| AL-TD-005 | Run + `al_run_lease` + active lease partial unique index + pull/ack/renew | Partial | `al_run`, `al_run_lease`, `uq_al_run_lease_active`; `agentlet/pull`; `agentlet/ack`; lease tests; `src/db/transaction.ts`; `src/db/postgres-statements.ts`; `scripts/db-smoke.mjs`; `test/postgres-statements.test.ts`; `test/transaction.test.ts` | `renew` endpoint and live PostgreSQL repository adapter are not implemented; row-lock / active-lease semantics are captured as SQL contracts and tested textually, with optional real DB smoke gated by `AGENTLINK_DATABASE_URL`. |
| AL-TD-006 | `control_actions` / poll + recover + cancel | Not started | State matrix has planning entries for recover/cancel/revoke | No HTTP protocol or runtime implementation yet. |
| AL-TD-006B | Retry watcher, `attempt_no` / `retry_count` / `max_retries`, late-complete protection | Partial | `src/domain/retry.ts`; `completeRun(FAILED)` creates a new queued run attempt when retryable; tests cover retryable failure | Lease-expiry watcher, run-timeout watcher, and late-complete integration tests for retry races remain. |
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

1. Finish the remaining live PostgreSQL adapter part of AL-TD-002 / AL-TD-005 when a Postgres client/DSN strategy is approved: execute the current SQL contracts through a repository implementation and add real concurrent pull tests.
2. Implement AL-TD-003 grant evaluation enough for Scheduler pre-checks.
3. Implement AL-TD-006 control actions / cancel / recover.
4. Implement AL-TD-007 Codex Runner Adapter.
5. Implement AL-TD-008 Telegram adapter and then run the first real end-to-end M1 loop.

## 2026-06-11 AL-TD-002/005 repository-spike update

- Added `src/db/transaction.ts` as the repository transaction boundary abstraction.
- Added `src/db/postgres-statements.ts` to freeze the M1 PostgreSQL contracts for queued-run leasing, ack accept/reject, progress append, terminal complete, and terminal-complete replay.
- Added `scripts/db-smoke.mjs` and `npm run db:smoke`; it is optional without `AGENTLINK_DATABASE_URL` and applies the migration inside a temporary schema when a DSN + `psql` are available.
- Added tests for transaction commit/rollback, SQL row-lock / active-lease predicates, ACKED/RENEWED execution guards, terminal replay scoping, and `terminal_payload_hash` migration persistence.
- Kept the task status as Partial because there is still no live PostgreSQL repository adapter, no real concurrent database test, and no `lease/renew` endpoint.
