---
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/worker': patch
---

Turn on the supply-chain gate that was never configured, and hold the Cloudflare runtime to one copy
with an assertion rather than an override.

Three of these are follow-ups to the 2026-08-25 dependency refresh, but two of them turn out not to
be about that PR at all.

**The `minimumReleaseAge` gate has been off the whole time.** `pnpm-workspace.yaml` carried a
maintained, documented, argued-over `minimumReleaseAgeExclude` list, and CLAUDE.md described a
24-hour window that installs enforce. pnpm has no default for `minimumReleaseAge`, and the value was
set nowhere: it derives `maximumPublishedBy` as `opts.minimumReleaseAge ? ... : undefined`, so an
unset value is not a shorter window but no window at all, and the exclude list beside it governs
nothing. Verified against pnpm 11.23.0 by resolving `hono@^4.13.0` twice: unset it takes 4.13.4,
published 17 hours earlier; with `minimumReleaseAge: 1440` it takes 4.13.3. The setting is now
present, which is the whole fix, and CLAUDE.md leads with the fact that the exclude list is inert
without it. Re-resolving the tree under the armed gate moved nothing, so nothing in the lockfile was
younger than the window it should always have been held to.

That also settles the `pg-boss@12.28.0` exception the refresh added with a PRUNE ME note. It is
gone, along with the last third-party entry; it was never doing anything anyway.

**The `wrangler` override is replaced by the assertion it was standing in for.** The invariant is
one wrangler, and through it one workerd and one miniflare, because the Worker suite runs inside
`@cloudflare/vitest-pool-workers`' workerd while `wrangler deploy` ships wrangler's. A top-level
override cannot express that: it OVERRIDES the pool's exact pin instead of TRACKING it, so the next
pool bump would be forced silently back to our number and the pool would run against a wrangler it
never pinned. Every package that declares wrangler already pinned it exactly, so the override was
load-bearing only in the direction that hurts; removing it re-resolves to the same single 4.124.0.
`scripts/check-cloudflare-runtime-pins.mjs` now fails CI when a second copy of any of the three
appears, which catches the pool bump and every other route to a split as well.

**`@cloudflare/workers-types` is pinned to the workerd date and joins that count.** Its version IS a
workerd date, so the caret left the types eight days ahead of the runtime, where an API added in the
gap typechecks green and throws in production. `wrangler@4.124.0` names the right answer itself: its
own peer range on the package is `^5.20260815.1`, matching `workerd@1.20260815.1`. Pinning the four
workspace declarations was not enough on its own, which is the part worth knowing: `autoInstallPeers`
kept filling drizzle-orm's optional peer slot (`>=4`) and wrangler's own, wherever a package declares
wrangler without the types beside it, from the newest published version, quietly reinstating
5.20260823.1 beside the pin. That needs the override, and the guard is what makes the duplicate
visible instead of silent. The published `peerDependencies` range on `@cat-factory/gatekeeper-worker`
stays wide, as a library's must.

**Stryker 10's floors are provisional, and now say so.** The refresh described the major as a Node 20
drop; it also added `emptyExpressionMutator` to the default set, enlarging the mutant population in
all three mutated packages, and the score floors were last measured under 9.6.1. Each floor now
records the version that measured it, and `docs/internal/mutation-testing.md` makes a Stryker major a
re-measure, because a floor is only a fact about the mutator set behind it.

Also drops `@cat-factory/deploy-harness` from the refresh's changeset. Nothing in that package moved,
and its version IS the deploy image tag, so versioning it would have rolled every deploy pin to
0.2.16 and republished a byte-identical image, contradicting the same changeset's statement that the
deploy image stays at 0.2.15.
