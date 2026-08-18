---
---

Tooling and docs only: a `kaizen-sweep` skill that drains a deployment's Kaizen backlog through the
public API and files what the graders recommend into `docs/internal/kaizen-tracker.md`, plus the
seeded tracker itself.

The gap it closes is that nothing consumed the entries surface published in #2051. Post-run
gradings accumulate on a deployment, the app shows them one board at a time, and a recommendation
has never had anywhere to land, so the same complaint is graded and forgotten once per run. The
tracker gives it a home; the ledger at the foot of it is what makes the loop incremental, and it
holds the entries that produced no finding too, since otherwise "we looked and there was nothing"
and "we never looked" read the same on the next sweep.
