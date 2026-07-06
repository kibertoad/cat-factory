---
'@cat-factory/integrations': patch
---

Stack-recipes-and-shared-stacks slice 9 (pilot): add the sanitized pilot fixtures, golden
detection tests, reference recipe/shared-stack configs, and the upstream-drift-alarm script
(`pilot:golden`) under `@cat-factory/integrations`. No runtime `dist` change — this pins the
deterministic provisioning detector's output against a faithful, sanitized snapshot of the
initiative's acceptance repos and doubles as an upstream-drift alarm.
