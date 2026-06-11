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

## Current skeleton

- Node.js 22 + TypeScript strict mode.
- Built-in HTTP server with `/healthz`, `/readyz`, and version metadata.
- PostgreSQL schema migration spike under `migrations/`.
- Domain state machine helpers under `src/domain/`.
- Node built-in test runner.
- GitHub Actions CI.

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run check
npm run build
npm start
```

## GitHub remote

This repository is intended to live at:

```text
git@github.com:whiteParachute/agentlink.git
```

If the remote repository does not exist yet, create it under GitHub account `whiteParachute` before pushing.
