# Extensible custom-gate config (ambient field augmentation)

Status: **proposal / not started.** Spun out of the deployer-single-provisioner work (which
introduced the named-step pipeline authoring the extensible `gate` field builds on). No code yet.

## Goal & rationale

A pipeline step's human gate is a bare boolean on the wire (`Pipeline.gates: boolean[]`). With the
named-step seed authoring now in place (`definePipeline` — a step is `{ kind, gate: true }`), the
`gate` field is the natural seam to let a **custom gate carry its OWN config fields** — a threshold,
a watch window, an approver set — instead of hard-coding every gate's knobs in the engine. "Ambient"
= a gate registered via `registerGate` declares its config shape, and the authoring form + the
runtime + the frontend all derive from that registration rather than each hard-coding the fields.

Concretely, the target authoring shape:

```js
definePipeline({
  id: '…',
  steps: [
    'coder',
    { kind: 'my-approval-gate', gate: { approvers: ['sre'], minReviews: 2 } }, // custom fields
    'merger',
  ],
})
```

…where `my-approval-gate` was registered with a config schema, and its `{ approvers, minReviews }`
flow to the gate at runtime.

## Why it's not in the deployer PR

The wire contract is boolean-only today, so "new fields at runtime" is a cross-cutting contract +
registry change, not a seed-authoring tweak — deliberately kept out of the focused deployer PR
(decision: separate follow-up initiative).

## Sketch (to be refined)

1. **Contract:** add a per-step `gateConfig?: Record<string, unknown>` (index-aligned, optional) to
   the `Pipeline` wire schema in `@cat-factory/contracts`, mirrored on the live `PipelineStep`
   state. Keep `gates: boolean[]` as the "is this a human gate" flag; `gateConfig` carries the
   custom fields.
2. **Registry:** `registerGate` (kernel gate registry) gains an optional config **schema**
   (Valibot) describing a gate's fields, so validation + the frontend form are derived, not
   hard-coded. Built-in gates (ci/conflicts/post-release-health) declare their existing knobs
   through it.
3. **Seed builder:** widen `SeedStep.gate` from `boolean` to `boolean | Record<string, unknown>`;
   `definePipeline` lowers the object into `gateConfig` (and `gates[i] = true`).
4. **Runtime:** thread the resolved `gateConfig` into `GateDefinition.probe` / the gate helpers, so
   a gate reads its config from the step instead of a global.
5. **Persistence (both runtimes):** map the new `gateConfig` column D1 ⇄ Drizzle (keep the runtimes
   symmetric); add a cross-runtime conformance assertion.
6. **Frontend:** render the registered gate's config fields in the pipeline editor (ambient from the
   registry), and round-trip them.

## Conventions carried from the deployer work

- Author built-ins with `definePipeline` named steps (never index-aligned boolean arrays).
- Keep the wire shape backwards-shaped only where cheap; pre-1.0, prefer the clean shape.
- Any persisted field lands in BOTH runtimes + a conformance assertion in the same change.
