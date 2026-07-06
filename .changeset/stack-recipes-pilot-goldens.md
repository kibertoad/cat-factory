---
'@cat-factory/integrations': patch
---

Stack-recipes-and-shared-stacks slice 9 (pilot): add the sanitized pilot fixtures, golden
detection tests, reference recipe/shared-stack configs, and the upstream-drift-alarm script
(`pilot:golden`) under `@cat-factory/integrations`. No runtime `dist` change — this pins the
deterministic provisioning detector's output against a faithful, sanitized snapshot of the
initiative's acceptance repos and doubles as an upstream-drift alarm.

Rename the pilot's placeholder consumer from `acme-main` to `acme-monolith` across the
fixtures, goldens, reference configs, tests, and docs (and the drift script's live-clone env
var `ACME_MAIN_DIR` → `ACME_MONOLITH_DIR`) for a clearer name; still fully sanitized, no
upstream names.
