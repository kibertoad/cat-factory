---
---

CI: gate the heavy test lanes on what actually changed. A docs-/prose-only PR now runs no
test lanes at all, and a frontend-only PR skips the pure-backend worker + Postgres lanes.
Change detection uses a second `dorny/paths-filter` pass with `predicate-quantifier: every`
so markdown/`backend/docs` exclusions actually subtract, and the aggregated `Test` gate
treats a change-gated skip as a pass while requiring the detection job itself to succeed.
