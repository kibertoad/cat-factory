---
'@cat-factory/prompt-fragments': minor
---

Technological-migration initiative — slice T4: the `migration.*` best-practice prompt-fragment
collection.

Adds a new `migration` collection to the universal fragment catalog — the default fragment pack
the upcoming `preset_tech_migration` initiative preset applies to the coding, testing and document
agents it spawns. Three fragments, each a standalone standard folded verbatim into an agent's
system prompt when selected:

- **`migration.discipline`** — the invariant methodology: establish the full (direct + transitive)
  blast zone before touching anything, pin observable behaviour with tests BEFORE the swap
  (coverage before delivery), decide the backwards-compatibility degree deliberately, deliver
  incrementally with the behaviour suite green throughout, and finish by removing the old path.
- **`migration.behaviour-preservation`** — how to prove the swap is behaviour-neutral: characterize
  at a seam ABOVE the swapped layer, assert observable outcomes (never raw vendor error codes,
  implicit ordering, or locking/isolation mechanics), preserve the edge-case semantics that silently
  differ across technologies (NULL vs empty string, precision/rounding, collation, pagination,
  identity exposure), and keep set-based work set-based — never a per-row app-side loop (the N+1
  regression trap).
- **`migration.confidence-case`** — the authoring standard for the evidence-backed coverage proof a
  human audits before delivery: a per-touchpoint map of inventory row to NAMED covering tests and
  the behaviour each pins, gaps/waivers justified against the coverage bar, risk mitigations, and
  the safety nets — grounded evidence, not assertion, from the single writer of the case document.

Pure additive catalog data (existing fragments and the catalog contract are unchanged); wired into
`FRAGMENTS`, resolvable via `getFragment`. The prompt-fragments package gains a vitest suite that
locks the collection's shape and intent.
