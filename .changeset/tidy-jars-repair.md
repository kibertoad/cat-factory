---
'@cat-factory/contracts': patch
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Remove the two expired persistence repairs and collapse the four run-failure parsers onto one.

The pre-#94 numeric user-id repair and the removed-failure-kind repair both carried a 2026-07-15
removal date that has passed, so `createdBy` and `initiatedBy` now read straight through and a
persisted failure is validated once, against the full wire schema.

Dropping `isKnownAgentFailureKind` left the bootstrap and env-config-repair repositories — two per
runtime — hand-rolling a weaker `typeof o.kind === 'string'` check than the execution mapper's, so
they now share one `parseStoredAgentFailure`, exported from `@cat-factory/contracts` beside the
schema it validates against (the runtimes' repositories no longer reach into
`@cat-factory/server` for it, and kernel deliberately carries no valibot dependency). A
structurally-incomplete failure record that those four stores previously surfaced (and that would
fail the SPA's snapshot re-validation) is dropped consistently on both runtimes.

Rows still holding a pre-#94 numeric id now surface it as-is instead of being repaired to null. A
deployment that still carries such rows sees the whole board fail to load with "Can't reach the
backend" — the SPA rejects the workspace snapshot — which points nowhere near the cause, so the
remedy is worth stating: null the stale ids once
(`UPDATE blocks SET created_by = NULL WHERE created_by ~ '^[0-9]+$'`, and the same for
`initiatedBy` inside the `agent_runs.detail` JSON). They identify no `usr_*` user, so nothing real
is lost.
