---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

A deployment can register its own REWORK PAIR: a producer, and a companion that grades its
output and loops that producer back for automatic rework below the step's threshold.

The companion catalog was a module-global `Map` of four built-ins, so the only way to express
"my producer, reviewed and bounced below a bar" was to reach for a judge — a different machine.
A judge scores against a rubric and disposes (advance / park / bounce / fail); a companion drives
the producer's own bounded rework budget and only then involves a human. The workaround got the
scoring and lost the loop.

The pairing now lives on `AgentKindRegistry` (`registerCompanion`), beside traits, skills, tool
servers and variants, rather than on a sixth registry: a companion is a relationship BETWEEN
agent kinds. The built-in catalog is pre-loaded, so registering one adds rather than replaces,
and module identity stops mattering for a separately-published extension package.

Two things a reviewer should look at. The free lookups take the registry OPTIONALLY and fall
back to the built-ins, copying `isGatableKind` — which means a call site that omits it silently
sees built-ins only, so every engine site that could meet a deployment's pair now threads it
(dispatch routing, the rework loop's producer search, the step-gating cascade, run-start
threshold seeding, pipeline-shape validation, the container job body, the prompt). And the
pairing is registered SEPARATELY from the kind, so the snapshot projection asks the registry
rather than reading a kind's own definition, which would have missed every one.

The SPA learns a custom pairing from the snapshot (`customAgentKinds[].companionTargets`) so the
builder renders it as an "add companion" toggle on its producer rather than a placeable palette
block that pipeline validation would then refuse on save. Built-in pairings win on collision: a
deployment cannot silently re-point `coder` at its own reviewer and change what every stock
pipeline does.
