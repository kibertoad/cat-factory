---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add a **human-testing gate** (`human-test`) pipeline step. When reached it spins up an
ephemeral environment and PARKS for a person to validate the change in the live URL before
the run continues. From the dedicated window the human can confirm (tear the env down +
advance), submit findings to dispatch the Tester's `fixer` (then the env rebuilds for
re-testing), pull latest main into the PR branch + redeploy (a clean merge rebuilds the env; a
conflict dispatches the `conflict-resolver`), or recreate / destroy the env on demand. Falls
back to a degraded manual mode (no live env, still parks for confirmation) when no
ephemeral-environment provider is wired.

New opt-in pipeline `pl_human_review` (`coder → reviewer → human-test → conflicts → ci →
merger`) and a palette block; existing default pipelines are unchanged.

Adds a `GitHubClient.mergeBranch` (the repo Merges API) and a `BranchUpdater` port behind the
"pull main" action, wired from the GitHub client on every facade (Worker / Node / local), plus
a `human_test_ready` notification type (in-app + Slack-routable). Both runtimes wire the gate
identically and the cross-runtime conformance suite asserts the park → request-fix → confirm
flow.
