---
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Make the environment self-test's "not provisionable" error specific and actionable.

The `env_test_not_provisionable` conflict passed its handler sub-reason as `{ reason }`, which
`ConflictError` merges as `{ reason: code, ...details }` — clobbering the `env_test_not_provisionable`
code on `error.details.reason`, so the SPA fell back to the raw backend string instead of its mapped
copy + "Configure infrastructure" jump. The sub-reason now rides on `details.handlerIssue`, keeping
the code intact, and the service inspector's self-test error renders a case-specific remedy
(no handler configured vs. an ambiguous match) with a one-click jump to Infrastructure → Test
environments.
