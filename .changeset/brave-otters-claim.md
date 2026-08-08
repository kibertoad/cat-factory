---
'@cat-factory/executor-harness': minor
'@cat-factory/server': patch
---

Give each repo in a multi-repo run a checkout directory that is actually its own.

The sibling checkout directory was `safeDirSegment(owner)__safeDirSegment(name)`, documented on
both sides as collision-free because GitHub owners contain no `_`. That argument does not survive
GitLab. `owner` there is a namespace PATH, so `grp/sub` folds onto the same segment as a top-level
group named `grp-sub`, and GitLab paths allow `_`, so `a__b` + `c` and `a` + `b__c` join to one
name. Either way two legs of a multi-repo run claim one directory, and the second leg's clone then
fails against a directory the first already filled, killing the run in the clone phase without
naming a repo.

The directory is now `owner__name__digest`, where the digest is FNV-1a over the UNSANITISED pair.
It stays a pure function of that pair, which is what lets the harness, `siblingCheckoutDir` and
the merger prompt each compute it independently with no shared ordering or state; a stateful
collision dance could not have been reproduced across three call sites that see different lists.
The harness's conformity suite now pins the two implementations against each other whole, rather
than against a join recomposed in the test, and asserts separation on the pairs that actually
collide.

Runner image bump: harness `src/**` changed, so deployments must move to the newly pinned tag.
Existing multi-repo checkout directories are named differently after this; nothing persists them.
