---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Install a service's dependencies into the checkout before the agent's first turn.

Agents opened a fresh shallow clone and saw manifests, not dependencies — they could read that a
library was depended upon but not what it exposed, so they guessed at APIs, re-derived type shapes
sitting on disk, or declined work they could have done. A service frame can now declare one
install command (autodetected alongside its validation checks) that the harness runs against the
checkout before the agent starts.

It shares the `validation_configs` row with the pre-PR checks so resolution costs no extra
round trip, but the two are threaded onto the job body under deliberately different rules: the
checks ride only a PR-opening coding dispatch, the install rides every dispatch that gets a
checkout — reviewers and architects most of all. Either may be declared without the other.

The install is never a gate: a failure becomes a note in the agent's prompt and the run continues.

Bumps the runner image (harness `src/**`) and adds a nullable `dependency_install` column to
`validation_configs` on both runtimes.
