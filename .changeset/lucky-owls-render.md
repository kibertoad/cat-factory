---
'@cat-factory/app': patch
---

Render the panel sections that were silently dropped, and stop an omitted optional query param from reaching the server as `key=`.

Seven components were used in templates without an explicit import. Nuxt registers a layer component under its path-prefixed name, so each bare tag resolved to nothing and rendered no output at all: the PR review window lost its per-standard fragment-adherence ratings, the reports panel its spend breakdowns, the environment wizard its stepper header, and the step-detail, risk-policy and task-run-settings panels a section each.

Separately, `sendContract` now drops `undefined`-valued query keys before serialising. `fast-querystring` renders `{ blockId: undefined }` as `blockId=`, which the server validates as an empty string, so any optional param with a `minLength(1)` rejected the request. An unscoped `listTasks()` was a guaranteed 400.
