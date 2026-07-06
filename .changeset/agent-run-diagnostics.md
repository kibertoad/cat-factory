---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
---

Capture per-run diagnostics on `agent_runs` for after-the-fact investigation. Each run now
records a `diagnostics` object (riding in the run's `detail` JSON, like `notes`/`frontendBindings`)
with the most recent container-step dispatch context — `agentKind`, resolved `model`, the `repo`
(owner/name/baseBranch/provider), the **execution backend** (`local-native` vs `local-container`
vs `runner-pool` vs `cloudflare-container` — the datum that distinguishes a native host-process run
from a sandboxed container), and the control-plane host `platform`. The backend is reported by the
runner transport (a new optional `RunnerTransport.backend` / `RunnerJobView.backend`, stamped by
the shared job client; the native/container router stamps its per-job leg).

Also preserves the harness's fine-grained failure `cause` (`git` / `api` / `no-usable-output` /
`no-changes`) on the failure's machine-readable `reason` instead of collapsing it to the coarse
`agent` kind — so a push/clone failure reads as `git`, not a generic agent error, without grepping
the transcript. No schema migration (the diagnostics ride in the existing `detail` column; the
cause rides on the existing `failure.reason`); mirrored across both runtimes with a cross-runtime
conformance round-trip assertion.
