---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Decide a merge-preset guard where the row lands, against the role granted there

Review of the cross-home reparent guard found the same mistake it was closing, one layer up: the
guard resolved against the ACTING board. On a board that mounts a service homed elsewhere, that is
neither where the row lands nor where the role that governs it was granted, and `blockRepository.get`
is scoped by physical `workspace_id`, so a run can only ever resolve a block under its HOME. The
acting board therefore answers the question only when it happens to be the home.

Both halves now resolve at the home. The LIBRARY: `addTask` judges against the workspace the row is
about to land in and `updateBlock` against the one it lives in. Judged at the acting board, a task
in a mounted foreign service had both sides of the swap collapse onto the acting workspace's default,
so the guard could not refuse anything: clearing a strict pin on such a task was the same escape the
drag was.

The ROLE: the editor now travels as a `BlockEditAuthority`, resolved per workspace, and each side of
a comparison is read against the tier that side's workspace granted. `refuseRiskPolicySelection`
takes two sides, each carrying its own actor; a same-workspace swap (the picker, a `riskPolicyId`
patch) passes the same actor to both. One pre-resolved actor was wrong in both directions at once:
an admin of a third board skipped the check on two homes where they are a plain member, and a
member of it was refused on roles they hold nowhere the decision applies. A workspace the editor cannot
see resolves to the unattributed editor, deliberately: with no tier there they can admit no run
under its policies, and reading absence as "unrestricted" would refuse a move into a service they
are not a member of, naming a sandbox nobody would have escaped.

Three more findings from the same review:

- The moved subtree was filtered to `level === 'task'`, exempting the `initiative` blocks that start
  their own planning chains and resolve a preset of their own. It reads the declared
  `BLOCK_LEVEL_RUNS_PIPELINES` now, a total `Record<BlockLevel, boolean>`, so a level that becomes
  runnable fails the typecheck until it is classified rather than being silently exempt.
- The guard resolved each pinned preset with a point read per pick, re-reading each workspace's
  default alongside every one of them: the N+1 this repo bans. It reads each side's library once and
  resolves in memory through the same `resolveRiskPolicy` the engine uses, so a hundred-task module
  costs two queries. `RiskPolicyRead` takes a typed target rather than a cache-key string, which is
  what lets a preloaded reader answer without parsing a key prefix back apart.
- A refused drag reached the user as untranslated English: the claim that the SPA's existing mapping
  covered it was wrong, since the only mapping was the picker's client-side one, worded for someone
  holding a control this person never touched. The reason now maps to `board.toast.moveRefused.*`,
  translated in all ten locales, with the backend's prose kept as the last resort.

Compatibility: `refuseRiskPolicySelection`'s input shape and the `BlockEditActor` parameter on the
board writes both changed. Internal only, so no migration path: neither is on the public API
surface, and no persisted shape moved.
