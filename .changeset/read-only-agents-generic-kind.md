---
'@cat-factory/server': patch
'@cat-factory/agents': patch
---

Migrate the read-only built-in agents (`architect`, `analysis`, `bug-investigator`) onto
the generic, manifest-driven `agent` harness kind — the first step of the strangler that
converts every built-in to the custom-agent model.

`ContainerAgentExecutor` now dispatches the read-only kinds through `buildRegisteredAgentBody`
with a synthesized `container-explore` step, so they ride `kind: 'agent'` in `mode: 'explore'`
(the SAME path a deployment's registered `container-explore` kind takes) instead of the
bespoke `explore` dispatch kind. The job body is byte-identical to the old `/explore` body
(same branch resolution, prompts and web-tools) bar the harness-internal temp-dir label, and
the prose result maps to `output` exactly as before — a behaviour-preserving reroute, not a
behaviour change. The already-shipped executor-harness image serves this via its generic
`handleAgent` handler, so no image bump is required.

The now-dead `/explore` harness handler (`handleExplore` / `parseExploreJob` / the `explore`
dispatch kind) is removed in a follow-up once parity is confirmed on CI.
