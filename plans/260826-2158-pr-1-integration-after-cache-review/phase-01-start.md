---
phase: 1
title: "Integrate PR 1 Safely"
status: pending
priority: P1
dependencies: []
---

# Phase 1: Integrate PR 1 Safely

## Overview

Resolve PR #1 on top of the reviewed dirty cache/archive/payment update, then push and merge only after local and GitHub gates pass.

## Requirements

- [ ] Preserve schema v4 archive semantics and payment transaction safety.
- [ ] Bring forward only PR #1 behavior that is compatible with the reviewed cache design.
- [ ] Keep external/production writes out of scope unless explicitly authorized.

## Implementation Steps

1. Save the current dirty reviewed patch as a recovery artifact or commit before source edits.
2. Create an integration branch from `main`; apply current dirty cache update first.
3. Compare `origin/pr-1` file by file and merge overlap manually, not via blind checkout.
4. Reconcile schema fields, cache state, locks, mirror pull, payment sync, and CLI status behavior.
5. Decide retained scripts; remove hard-coded local paths or keep scripts out of the merge.
6. Run focused tests, builds, lint, and optional full test suite.
7. Commit with a conventional message, push, update PR #1, re-check mergeability, then merge.

## Todo

- [ ] Baseline/recovery point captured.
- [ ] PR overlap resolved.
- [ ] Tests and builds passing.
- [ ] PR #1 updated and merge gate passed.

## Success Criteria

PR #1 is merged with the reviewed dirty safety fixes intact, or the integration branch is rolled back to the pre-integration baseline with clear evidence of the failing gate.
