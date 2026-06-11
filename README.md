# Agentlink

Agentlink is a lightweight control plane for coordinating personal AI agents across devices. It keeps user entry points simple, routes tasks to trusted device-side agentlets, and lets each device execute with its local runners and credentials.

The first milestone focuses on a single personal loop:

```text
Telegram -> Agentlink Control Plane -> Device Agentlet -> Codex CLI -> Telegram
```

## Why Agentlink

Modern AI work often spans several machines, networks, tools, and message channels. Agentlink provides a small, explicit layer for:

- registering devices and their available runners;
- turning user messages into trackable tasks and runs;
- leasing work to device-side agentlets without exposing devices publicly;
- streaming progress and final results back to the originating channel;
- keeping credentials and local execution authority on the device that owns them.

## Core concepts

- **Task** — the user-level request created from an inbound channel message or API call.
- **Run** — one executable attempt for a task, including retry metadata.
- **Lease** — a time-bound assignment that gives one agentlet exclusive execution rights for a run.
- **Device** — a trusted machine that can host one or more runners.
- **Agentlet** — the device-side process that pulls work, runs local tools, and reports progress.
- **Runner** — a local execution backend such as Codex CLI.

## Current status

Agentlink is in early development. The repository currently contains:

- a Node.js 22 + TypeScript control-plane skeleton;
- a minimal HTTP API for tasks, devices, leases, progress, and completion;
- an in-memory implementation for executable protocol tests;
- PostgreSQL schema, SQL contracts, repository adapter, `pg` runtime adapter, and opt-in PostgreSQL server mode wiring;
- GitHub Actions CI and Node built-in tests.

Not yet included: live PostgreSQL DSN/concurrency verification, Telegram adapter, device agentlet daemon, Codex runner adapter, or production deployment guide.

## Quick start

```bash
npm ci
npm run check
npm start
```

The server exposes:

- `GET /healthz`
- `GET /readyz`
- `GET /api/v1/meta`

Optional PostgreSQL migration smoke test:

```bash
AGENTLINK_DATABASE_URL=postgres://... npm run db:smoke
```

Without `AGENTLINK_DATABASE_URL`, the smoke test exits successfully with a skip message.

Optional PostgreSQL-backed server mode:

```bash
AGENTLINK_STORAGE=postgres AGENTLINK_DATABASE_URL=postgres://... npm start
```

The default remains `AGENTLINK_STORAGE=memory` for local protocol smoke tests.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run db:smoke
```

Runtime dependencies are intentionally small; `pg` is included because PostgreSQL is the control-plane source of truth for deployable M1 state.

## License

Agentlink is released under the MIT License. See [LICENSE](./LICENSE).
