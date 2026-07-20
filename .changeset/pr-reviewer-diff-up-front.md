---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
---

Hand the `pr-reviewer` the PR diff up front to cut token burn.

A deep PR review used to clone the base branch and reconstruct the diff by hand (many `git diff`
runs + grep passes), and each agentic turn re-sends the whole growing transcript — so the
discovery turns dominated the run's token cost. A new `pr-reviewer` preOp now computes the
changed-file list + per-file patches on the backend (via the previously-dormant
`GitHubClient.listChangedFiles`) and injects them as `.cat-context/pr-diff.md`, so the agent plans
its slices from a prepared artifact instead of rebuilding the diff.

Backend-only and runtime-symmetric (rides the shared `ContainerAgentExecutor` + the HTTP-only
`RepoFiles` port), no harness image bump. New seams: `RepoFiles.listChangedFiles?` (forwarded from
the wired client), and `RepoOpResult.contextFiles` → `AgentRunContext.injectedContextFiles` so a
preOp can hand the agent context files up front. The full base clone + git fallback stay, so a
deployment without the capability (or an unresolvable PR) passes through unchanged. See
`docs/initiatives/pr-review-turn-reduction.md`.
