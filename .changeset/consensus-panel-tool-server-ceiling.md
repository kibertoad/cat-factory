---
'@cat-factory/orchestration': patch
'@cat-factory/consensus': patch
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
---

Slice 9 of the `mcp-maturation.md` tracker: a consensus-diverted step now states the tool servers
(MCP) it cannot reach, instead of losing them in silence.

A panel runs its participants as inline model calls with no checkout and no agent CLI, so there is
nowhere to wire an MCP server. Nothing said so. Boot validation's `tool_servers_without_container`
warning keys on the kind's declared surface, which is a container for nearly every consensus-eligible
kind (architect, analysis, the reviewers), and that is exactly the set a deployment attaches a
read-only research server to; the container executor, which owns the whole unavailability vocabulary,
is not on this path at all. So the prompt promised nothing, the step recorded nothing, and a diverted
step read exactly like a kind that had declared no tool servers.

The panel now reports it in both channels a container dispatch uses. The participants' system prompt
carries the same `toolServersSection` a container run composes, after the surface statement, so a
model planning around the vendor tool its instructions name learns it is absent. And the step carries
the resolution: `AgentRunResult.toolServers` is the inline counterpart of `AgentJobHandle.toolServers`,
stamped with the dispatched kind by the engine through the same helper the container fold uses, so an
executor still cannot label a resolution with a kind other than the one that ran. A kind that declared
no servers records nothing at all, because an inline surface wires nothing by construction and an
all-empty record would claim a resolution where none was possible.

PUBLIC API, additive (OpenAPI `1.38.0`): the unavailable-tool-server `reason` vocabulary gains
`consensus_panel`, carried by the run reads that project `toolServers`. A member of its own rather
than `harness_unsupported` because no harness is involved: the kind's standard surface may serve the
server perfectly and the same step with consensus off would have got it, so a consumer acting on the
harness reason would go widening a list that was never the constraint.
