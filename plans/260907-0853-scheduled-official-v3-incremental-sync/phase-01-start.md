---
phase: 1
title: "Implement, verify, and roll out"
status: in-progress
priority: P1
effort: "1-2d"
dependencies: [260907-0700-official-v3-sync]
---

# Phase 1: Implement, verify, and roll out

The executable contract, file list, validation gates, risks, and rollout steps are consolidated in [plan.md](./plan.md) to keep this fast-mode plan short and avoid duplicated requirements.

## Todo

- [ ] Implement the three work packages in order.
- [ ] Satisfy every validation and success criterion in `plan.md`.

## Risk Assessment

Highest risks: wrong first-run boundary, clean-run `--resume` no-op, cursor reset after `409`, duplicate writers, and claiming full-cache freshness from four-resource partial coverage. The state matrix and canary gates fail closed on each.
