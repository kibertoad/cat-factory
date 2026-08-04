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
