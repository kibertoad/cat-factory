---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Shared stacks now declare their own preflight `prerequisites` (the slice-6 follow-up in the
stack-recipes-and-shared-stacks initiative). A `SharedStack` carries a
`prerequisites: PreflightRef[]` — the same machine-prerequisite vocabulary a consumer recipe
declares — and `SharedStackService` re-runs those checks at the START of every bring-up
(before clone / networks / `up`), streaming one provisioning-log step per check and failing fast
with copy-paste remediation when a REQUIRED check is red (a non-required one is advisory). This
closes the acme-shared-services M-rows (mkcert CA / hosts entries / ECR login) for the shared
stack itself, not just per-PR consumer recipes.

The probes are host-bound (local facade); a stack that declares `prerequisites` on a deployment
with no host-probe runtime fails loudly rather than silently skipping a declared safety gate,
mirroring the compose provider's `runPreflights` seam. Persistence is fully symmetric: a new
`prerequisites` text-JSON column mirrored D1 (`0042_shared_stacks_prerequisites.sql`) ⇄ Drizzle,
asserted by the cross-runtime shared-stack conformance round-trip. Pre-1.0, no data migration —
existing rows default to `[]` (no prerequisites), unchanged behaviour.
