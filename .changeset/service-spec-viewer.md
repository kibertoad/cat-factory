---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add a "View Requirements" button to a selected service in the inspector that opens a
structured navigation window over the service's prescriptive spec tree (modules → feature
groups → requirements + Given/When/Then acceptance criteria + domain rules). When the spec
is present on the service repo's default branch, a toggle switches to the rendered Gherkin
scenarios.

A new read-only endpoint `GET /workspaces/:ws/blocks/:blockId/spec` reassembles the sharded
`spec/` artifact off the repo default branch via the existing checkout-free `RepoFiles`
resolver (`resolveRunRepoContext`), now surfaced on the `ServerContainer` and wired
symmetrically on both runtime facades. It returns `{ present: false }` when GitHub is not
connected or no spec exists yet, so the window shows an empty state rather than erroring.
