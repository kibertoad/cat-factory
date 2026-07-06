import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragments for a TECHNOLOGICAL MIGRATION — swapping a load-bearing
// technology (a database engine, a framework major, a language runtime, a core
// library) behind a behaviour-preservation safety net. These are the default
// fragments the `preset_tech_migration` initiative preset applies to the coding,
// testing and document agents it spawns, so each body is written to steer WHATEVER
// agent carries out a slice of a migration — hence the deliberately broad `appliesTo`
// (a migration touches services, APIs, databases and libraries alike).
//
// Three concerns, one fragment each:
//   - `migration.discipline`             — the invariant methodology (blast zone →
//     coverage → transition → delivery → decommission; coverage BEFORE delivery).
//   - `migration.behaviour-preservation` — how to pin observable behaviour so the
//     swap is provably behaviour-neutral (outcomes at a seam, never internals).
//   - `migration.confidence-case`        — the authoring standard for the
//     evidence-backed coverage/confidence proof a human audits before delivery.
//
// The deep, phase-by-phase methodology (what a blast-zone report must enumerate, item
// granularity) lives code-side in the preset's `promptAdditions`, NOT here — these are
// the durable standards an agent follows while doing the work.

export const migrationFragments: PromptFragment[] = [
  {
    id: 'migration.discipline',
    version: '1.0.0',
    title: 'Migration discipline',
    category: 'Migration',
    summary:
      'Know the blast zone, pin behaviour before the swap, deliver incrementally, then remove the old path.',
    body: [
      'Technological-migration discipline:',
      '- What makes a migration safe is the discipline around it, not the code change: know the blast zone, pin behaviour, then swap — in that order.',
      '- Establish the full blast zone before touching anything: every directly affected touchpoint AND its transitive reach (callers of callers, config, scheduled jobs, ops tooling, CI).',
      '- Pin observable behaviour with tests BEFORE the swap. Coverage comes before delivery — never migrate code whose behaviour is not already characterised and green on the current technology.',
      '- Decide the degree of backwards compatibility deliberately (big-bang vs dual-run vs adapter layer) and state it; do not let it emerge by accident.',
      '- Deliver in small increments grouped by area, keeping the behaviour suite green on both the old and the new technology throughout — a red suite halts the migration.',
      '- Finish the job: prove parity on the new target, flip the defaults, and REMOVE the old path. A migration that leaves the legacy code and its dependencies behind is not done.',
      '- Record every non-obvious choice (a strategy per object, a retained legacy path, a compat posture) as an explicit decision, not a silent edit.',
    ].join('\n'),
    appliesTo: { agentKinds: ['spec-writer', 'architect', 'coder', 'tester', 'doc-writer'] },
  },
  {
    id: 'migration.behaviour-preservation',
    version: '1.0.0',
    title: 'Behaviour preservation',
    category: 'Migration',
    summary:
      'Pin observable outcomes at a seam above the swapped layer — never assert internals or vendor mechanics.',
    body: [
      'Behaviour-preservation standards for a migration:',
      '- Write characterization tests at a seam ABOVE the layer being swapped (the API / service / repository boundary) so they survive the swap unchanged and prove the new technology behaves identically.',
      '- Assert observable OUTCOMES, never internals or mechanisms: do not assert raw vendor error codes, implicit result ordering, or locking/isolation mechanics — assert the outcome a caller sees (the mapped error, an explicitly ordered result, the final committed state).',
      '- Preserve the edge-case semantics that silently differ between technologies: NULL vs empty string, numeric/datetime precision and rounding, string collation and case/trailing-space comparison, pagination stability, and any identity/sequence values that leak into responses.',
      '- Keep set-based work set-based. When replacing a set-based operation (a bulk statement, a set-based stored procedure) with application code, express it as one batched operation — NEVER an app-side per-row loop, which is an N+1 regression the old path did not have.',
      '- Establish the baseline first: the behaviour suite must be green on the CURRENT technology before any migration code lands, so a later failure unambiguously means the swap changed behaviour.',
      '- Be additive and traceable: add tests for behaviour that lacks coverage, name each test after the behaviour it pins, and never weaken or delete an existing assertion to make the new target pass.',
    ].join('\n'),
    appliesTo: { agentKinds: ['spec-writer', 'coder', 'tester', 'playwright'] },
  },
  {
    id: 'migration.confidence-case',
    version: '1.0.0',
    title: 'Confidence-case authoring',
    category: 'Migration',
    summary:
      'Author the coverage proof as evidence a human audits: per-touchpoint named tests, justified gaps, safety nets.',
    body: [
      'Confidence-case authoring standard:',
      'The confidence case is an evidence-backed proof that coverage is sufficient for delivery — a human reviews and challenges it, they do not re-derive the sweep. Every claim must be grounded; hand-waving is grounds for rejection, not a passing case. Structure it as:',
      '1. Expected blast zone — recap the touchpoint inventory and call out any deltas discovered since it was written.',
      '2. Coverage grounding — a per-touchpoint map: each inventory row to the NAMED tests that cover it and WHAT observable behaviour each test pins. Cite real test names and real touchpoints; a row with no evidence is a gap, not covered.',
      '3. Gaps and waivers — every uncovered or partially-covered touchpoint, each with an explicit justification, bounded by the stated coverage bar (strict = every touchpoint has a named covering test; pragmatic = waivers allowed, each justified).',
      '4. Risk mitigations — what was done to reduce the migration risk (staged rollout, seam isolation, rehearsal).',
      '5. Safety nets and safeguards — the dual-target test harness, the CI legs, the rollback / compatibility posture, and the gated delivery batches.',
      '- Be the single writer of the confidence-case document: append to it, never fork a parallel copy, and keep it the one source of the safety argument.',
    ].join('\n'),
    appliesTo: { agentKinds: ['coder', 'doc-writer'] },
  },
]
