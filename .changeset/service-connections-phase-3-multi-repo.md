---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/executor-harness': patch
---

Service connections Phase 3 — multi-repo coding. The implementer now fans a cross-service
change out across every connected involved-service repo, not just the task's own. A new
`resolveRepoTargets` resolves the task's own repo PLUS each involved service's repo, deduped
by repo (two services in one monorepo collapse into a single checkout with both
subdirectories noted; a service co-located in the primary's own repo rides the own-service
PR). `ContainerAgentExecutor` builds a `peerRepos` job body + a "Multi-repo workspace" prompt
section for the `coder` kind and works at the repo root so it can reach every involved
subtree. The executor-harness clones each peer repo as a SIBLING checkout under one workspace
root, runs the agent once across all of them, and opens one PR per repo it actually changed.
The own-service PR stays on `block.pullRequest`; the peer PRs are recorded on the new
`block.peerPullRequests` (`AgentRunResult.peerPullRequests` → engine → JSON column, mirrored
on D1 + Drizzle), with an `allPullRequests(block)` helper for the multi-repo-aware readers.
Peer clone URLs are host-allowlisted exactly like the primary. Bumps the runner image
(`peerRepos` job field + sibling-checkout flow).
