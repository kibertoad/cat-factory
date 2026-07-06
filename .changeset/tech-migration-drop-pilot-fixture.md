---
---

docs(tech-migration): drop the synthetic-fixture pilot (T9) and productized pilot run (T11).

The tech-migration initiative tracker now records that T9 (a bespoke synthetic MSSQL target
app) and T11 (a productized pilot run against it) are dropped: they are project-specific
throwaway, not platform code, and never run in cat-factory's CI. The migration preset's
platform validation is the in-CI T10 E2E (deterministic, fakes, extends the S9 baseline);
real-world confidence comes from running the preset against real repositories manually and
separately. Docs-only; no package behaviour changes.
