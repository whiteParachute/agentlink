# ADR 0001: M1 scope and stack

## Status

Accepted for implementation spike.

## Context

Draft 3 of the Agentlink M0 technical design passed review. M1 must prove the narrow loop:

```text
Telegram -> Agentlink -> claw-tenc agentlet -> Codex CLI -> Telegram
```

The control plane must not execute commands directly and must not store runner credentials.

## Decision

- Build a standalone GitHub repository owned by `whiteParachute`.
- Use Node.js 22 and TypeScript strict mode for the initial control-plane skeleton.
- Start with a modular monolith and raw PostgreSQL migrations.
- Use device-side agentlet pull/lease semantics; no control-plane inbound connection to devices.
- Represent retries as old terminal Run + new Run attempt.

## Consequences

- M1 implementation remains small enough to review and test.
- Runtime dependencies are intentionally deferred until concrete adapters require them.
- Schema, state transitions, and idempotency are testable before full Telegram/Codex integration.
