---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Pipeline-builder + default-models UI polish.

Pipeline builder: saved pipelines no longer render every agent-kind icon inline
(which overflowed the narrow panel) — each is a collapsed row showing its name and
step count that expands to the full ordered step list on click. Draft steps now
truncate their label so the per-step controls (gate / reorder / remove) always stay
reachable, and a "Configure models" button opens the default-models settings panel
straight from the builder. The left-nav action buttons are unified on the
primary-soft style of "Build a pipeline".

Default-models panel: restyled from a light modal into the dark full-screen window
used by the agent-output review overlay (readable regardless of the OS colour-mode
preference), with a filter box that narrows every kind's model picker. A kind left
on its deployment default now names the model that default actually resolves to
("Model · Provider (default)") instead of the opaque "Deployment default".

To support that, the workspace snapshot now carries `deploymentModelDefaults` — the
deployment's env-routing defaults as `provider:model` refs (`default` plus the
per-kind `byKind` overrides) — derived in the shared workspace controller from
`config.agents.routing`, so it is identical across the Worker and Node facades. A
cross-runtime conformance assertion guards that both surface it.
