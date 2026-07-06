---
'@cat-factory/kernel': minor
'@cat-factory/gates': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Complete the two deferred service-connections Phase 4 multi-repo follow-ups.

**Conflict-resolver peer targeting.** The `conflicts` gate now ESCALATES a conflict on a
connected involved service's PEER repo (previously it declined escalation and fast-failed the run
to a manual give-up). The gate still tags which repo conflicted (`conflictTarget`); the engine
threads that onto the dispatched `conflict-resolver`'s context, and the container executor points
the (single-repo) resolver at THAT peer repo — resolving its target, cloning its PR (work) branch,
and merging the peer's base in — instead of always the task's own service. An own-repo conflict is
unchanged (no `frameId` ⇒ the own service is the implicit target). Handles the peer-only case (own
service unchanged, so no own PR) by pinning the resolve branch to the shared work branch.

**Merger combined-diff.** The `merger` now scores the COMBINED cross-repo change on a multi-repo
task instead of only the own-repo diff. Driven by the PRs that actually exist
(`block.peerPullRequests`), it clones each peer PR's repo as a read-only sibling checkout at its PR
branch (full history) alongside the own service, and a "Multi-repo pull request" prompt section
plus the reworked merger prompts instruct it to diff each repo against its base and return ONE
blended complexity/risk/impact assessment covering the whole change. The read-only multi-repo
explore harness path gained per-peer `cloneBranch` selection and honours the job's `full` flag (a
new container capability — the executor-harness image is bumped), so the bug-investigator's
base-branch fan-out is unchanged while the merger checks each peer out at its PR head.
