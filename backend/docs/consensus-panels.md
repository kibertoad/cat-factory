# Consensus panels: multi-model review steps

An eligible step can run as a multi-model PANEL instead of a single agent
(`@cat-factory/consensus`, `CONSENSUS_ENABLED`). REVIEW kinds are the point, and the frontend
mirror `CONSENSUS_ELIGIBLE_KINDS` is hand-synced; extend both.

## A panel participant has NO checkout, and every layer preparing for it must know

`dispatchDeliversCheckout` (`@cat-factory/agents`) is the ONE definition, used by the executor's
ROUTING and by the engine as `RepoOpContext.deliversCheckout`, and it is deliberately FAIL-SAFE:
being wrong that way hands a container agent an inlined diff it didn't need, while being wrong
the other way has a panel reviewing from filenames while sounding confident. A preOp BRANCHES on
it rather than assuming a filesystem, naming what it could not inline as unreviewable instead of
passing it off as reviewed, and `INLINE_PANEL_SURFACE` is appended LAST so a workspace prompt
override cannot drop it.

## A panel also has no MCP tool servers, and STATES the ones it withheld

Same fact, second capability, and it needs its own reporting because neither layer that normally
names a withheld tool server can see this one: boot validation's `tool_servers_without_container`
warning keys on the kind's DECLARED surface, which is a container for nearly every eligible kind,
and the container executor (which owns the whole unavailability vocabulary) is not on this path at
all. So `panelToolServerCeiling` reports it in both channels the container dispatch uses: the
participants' prompt, through the SAME `toolServersSection`, and the step's own record, answered at
dispatch on `AgentExecutor.previewToolServers` and stamped with the dispatched kind by the engine, so
a panel that then throws still leaves a step saying what it could not reach. The reason is
`consensus_panel`, a member of its own because nothing about the harness is involved and the same
step with consensus off would have got the server. A kind that declared none composes an unchanged
prompt and records nothing: an inline surface wires nothing by construction, so an all-empty record
would claim a resolution where no wiring was possible. Design:
[`mcp-tool-servers.md`](./mcp-tool-servers.md).

## `userPromptFor` folds `injectedContextFiles` for every INLINE caller

Not the container path, and at the wrapper level; it must be the wrapper, because
`buildBaseUserPrompt` returns early for a kind that authors its own user prompt, and those are
exactly the kinds whose whole input arrives as context files. The fold is budgeted, states what
it dropped, and EXCLUDES standards files, which reach an inline caller through the SYSTEM prompt
at `standardsVerbosityFor`.

## The tier is chosen by the ENGINE at dispatch, never by the executor

A step declares `participants` inline or `consensus.groupIds` (a SET, not a precedence list, of
workspace groups each carrying an estimate bar); `resolveConsensusConfig` reads them in ONE
batched `listByIds` and the pure `selectConsensusGroup` picks the most demanding tier the
estimate clears, deterministically so a re-driven run re-picks the SAME tier.
`applyConsensusGroup` **drops the step's `gating`**: selection IS the gate. That is what keeps
the group library OUT of the optional package: the executor only ever receives an
already-decided `ConsensusStepConfig`. A gated group MUST name a threshold ("always applies" is
`enabled: false`), and deleting a group degrades the step to its remaining tiers rather than
rewriting pipelines.
