---
phase: 1
title: "Integrate PR 1 Safely"
status: in-progress
priority: P1
dependencies: []
---

# Phase 1: Integrate PR 1 Safely

## Overview

Local implementation, test, and review work are complete. GitHub push/update/merge is the only remaining execution step.

## Requirements

- [x] Preserve schema v4 archive semantics and payment transaction safety.
- [x] Bring forward only PR #1 behavior that is compatible with the reviewed cache design.
- [x] Keep external/production writes out of scope unless explicitly authorized.
- [ ] Push the integration branch, update PR #1, and merge after GitHub confirms the gate.

## Implementation Steps

1. Recovery point captured before source edits.
2. Integration branch and manual overlap reconciliation completed against `origin/pr-1`.
3. Schema fields, cache state, locks, mirror pull, payment sync, and CLI status behavior reconciled.
4. Retained scripts decision completed: all 16 PR-added scripts excluded from the merge.
5. Focused tests, builds, lint, and full test suite completed locally.
6. Independent re-review completed with no findings.
7. Push with a conventional message, update PR #1, re-check mergeability, then merge.

## Todo

- [x] Baseline/recovery point captured.
- [x] PR overlap resolved.
- [x] Tests and builds passing.
- [ ] PR #1 updated and merge gate passed.

## Success Criteria

PR #1 is ready to merge with the reviewed dirty safety fixes intact. Local validation is complete; only GitHub push/update/merge remains.
