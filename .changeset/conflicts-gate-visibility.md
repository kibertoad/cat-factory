---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/agents': patch
'@cat-factory/app': minor
---

Make the CI / conflicts gates observable. The gate window now shows the run id
(copyable, with a jump into observability), a per-attempt history of every
ci-fixer / conflict-resolver run (what each tried and how it ended), and — for
the conflicts gate — the resolver's own account of which files it left
conflicting (GitHub's API exposes mergeability as a single bit, so this comes
from the resolver, plus a link to inspect the PR on GitHub). Failing CI checks
now link straight to their GitHub run logs.

Mechanically: `GateStepState` gains an append-only `attemptLog`; the engine
records each gate-helper attempt when its job finishes (previously discarded the
moment the gate re-probed) and sets the conflicts gate's `lastFailureSummary`
from the resolver's output. `CiCheck` / `gateFailingCheckSchema` /
`githubCheckRunSchema` carry the check run's `html_url` so the UI can link to it
(populated on the live check-runs read; not persisted to the projection). The
conflict-resolver result mapping now surfaces the still-conflicting file list
(its `error`) instead of dropping it.

Also tightens the conflict-resolver prompt: lockfiles (`package-lock.json`,
`pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, …) must be regenerated via the package
manager rather than hand-merged — large generated files are what exhausted the
resolver's context window and left big conflict sets unresolved.
