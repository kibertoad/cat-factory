# The step taxonomy: agents, gates, one-shot steps, judges

A step's `agentKind` puts it in one of four buckets, and most engine handling keys off which one.
This page is the vocabulary the rest of the docs assume; the flows that use it are indexed in
[`docs/flow-index.md`](../../docs/flow-index.md), and the authoring ergonomics for adding a kind or
a gate are in [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md).

The one rule that belongs to no single bucket, and so is stated in the root
[`CLAUDE.md`](../../CLAUDE.md) instead: extending the engine means a REGISTRY ENTRY, never another
`evaluateX` / `pollX` / `awaiting_x` triple beside the generic machine.

## The four buckets

- **Agents**: a container or inline LLM does the work (`coder`, `architect`, `spec-writer`, `tester`,
  `merger`, the companions). Dispatched via `CompositeAgentExecutor`; container kinds park on
  `awaiting_job`.
- **Polling gates**: `ci`, `conflicts`, `post-release-health`. A gate runs a **programmatic precheck**
  against a provider and only escalates to a helper container agent (`ci-fixer` / `conflict-resolver` /
  `on-call`) on a negative verdict; skip-unless-needed is the whole point. ONE generic machine drives every
  gate (`evaluateGate` / `dispatchGateHelper` / `pollGate`, parking on `awaiting_gate`); a
  `GateDefinition` supplies only `wired()`, `probe()`, `helperKind` and `onExhausted`, and live state is
  `step.gate`. **Adding a gate is a new registry entry, never another `evaluateX`/`pollX`/`awaiting_x`
  triple**; ergonomics:
  [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md). Pure gate logic
  lives in kernel (`domain/gate-logic.ts`); `defaultGateRegistry()` is EMPTY and the built-ins
  (`@cat-factory/gates`) install themselves through the same public seam a deployment uses.
  **`resolveHelperCompletion`** is the seam for an INVESTIGATE-don't-fix helper (`on-call` never
  reverts), settling the gate without re-probing.
- **One-shot engine steps**: `tracker`, `deployer`, `requirements-review`. Bespoke handling; not gates
  because they don't poll-or-escalate.
- **Judges**: an inline LLM scores work against a rubric, disposing: advance / park / bounce the
  producing step with findings as `rework` / fail. **Adding a judge is a new registry entry**
  (`JudgeDefinition`). Model, and why it is neither a gate nor a `StepCompletionResolver`:
  [`judge-registry.md`](../../docs/initiatives/judge-registry.md).
- **Companions**: a REWORK PAIR looping the preceding producer back on a bounded budget before a
  human is asked; **added with `AgentKindRegistry.registerCompanion`**. Trap: the pairing is stored
  SEPARATELY from the kind and the lookups take the registry OPTIONALLY, so a read off a kind's own
  definition sees built-in pairs only. Doc: [`custom-agent-gate-ergonomics.md`](./custom-agent-gate-ergonomics.md).
- **The `merger` resolver is a privileged built-in, deliberately NOT externalized.** It owns terminal block
  status (`ownsTerminalStatus`) and executes a policy-gated real merge, so it keeps engine-internal access
  rather than the minimal public `ResolverContext`.

## Estimate gating

**A step's presence may be conditional on the task estimate; a HUMAN GATE never is.** Estimate gating
(`StepGating` → `shouldRunGatedStep` → `RunDispatcher.skipGatedStep`) skips a step when an earlier
estimate PRODUCER's scores fall below its thresholds; that is what lets ONE pipeline cover a range that
would otherwise need several near-identical presets. The three binding rules (gatability is a declared
per-kind capability, OFF by default, and structural kinds like `merger` stay unlisted; a skipped
producer CASCADES onto its companion via the persisted `step.skipped`; a step may not carry both
`gates[i]` and enabled `gating`, because an estimate may ADD a human checkpoint but never cancel one):
[`pipeline-catalog-collapse.md`](../../docs/initiatives/pipeline-catalog-collapse.md). The same
precheck-first idea applies inline: `hasNotesToIncorporate` short-circuits `runIncorporationCycle` so
the rework + re-review LLM calls are skipped when the human left nothing to fold in.
