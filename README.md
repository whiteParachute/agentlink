# Agentlink

Agentlink is an independent multi-device agent control plane. M1 is scoped to a single personal domain loop:

```text
Telegram -> Agentlink Control Plane -> claw-tenc agentlet -> Codex CLI -> Telegram
```

## M1 scope

- Control plane owns Task / Run / Lease / Device state, policy decisions, audit, and progress events.
- Device-side agentlet owns local execution and credentials.
- M1 uses a single personal domain, one always-on device (`claw-tenc`), and one required runner (`codex`).
- No work-domain integration, no DAG planner, no multi-device fallback, and no AgentDock chat-session reuse in M1.

## Current M1 slice

- Node.js 22 + TypeScript strict mode.
- Built-in HTTP server with `/healthz`, `/readyz`, and `/api/v1/meta`.
- In-memory control-plane repository for the first executable M1 slice.
- PostgreSQL repository spike artifacts for the next AL-TD-002/005 slice: transaction helper, SQL contract statements, and optional migration smoke runner.
- Minimal Task / Run / Lease / Device API loop:
  - `POST /api/v1/tasks`
  - `GET /api/v1/tasks/:taskId`
  - `GET /api/v1/runs/:runId`
  - `GET /api/v1/runs/:runId/events`
  - `POST /api/v1/devices/register`
  - `POST /api/v1/devices/:deviceId/heartbeat`
  - `POST /api/v1/agentlet/pull`
  - `POST /api/v1/agentlet/ack`
  - `POST /api/v1/agentlet/progress`
  - `POST /api/v1/agentlet/complete`
- PostgreSQL schema migration spike under `migrations/`.
- Domain state machine helpers under `src/domain/`.
- Node built-in test runner.
- GitHub Actions CI.
- M1 task status tracking in `docs/m1-task-status.md`.

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run check
npm run build
npm run db:smoke  # optional; runs only when AGENTLINK_DATABASE_URL is set
npm start
```

## GitHub remote

This repository is intended to live at:

```text
git@github.com:whiteParachute/agentlink.git
```

If the remote repository does not exist yet, create it under GitHub account `whiteParachute` before pushing.

## PostgreSQL smoke

`npm run db:smoke` is intentionally optional for local development and CI. When `AGENTLINK_DATABASE_URL` is unset it exits successfully with a skip message. When the variable is set, it requires `psql`, creates a temporary schema, applies `migrations/0001_initial.sql`, checks key schema invariants, and drops the schema.
