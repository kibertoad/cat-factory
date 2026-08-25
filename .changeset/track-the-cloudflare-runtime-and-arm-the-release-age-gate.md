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

**Stryker 10's floors are re-measured, and kernel's had almost no margin left.** The refresh
described the major as a Node 20 drop; it also added `emptyExpressionMutator` to the default set,
enlarging the mutant population, and the floors were last measured under 9.6.1. Re-measured on CI:
gates 651 -> 669 mutants and 90.78 -> 90.58, spend 396 -> 400 and 97.73 -> 97.25, both absorbed with
the floor untouched. Kernel took all of it, 7,316 -> 7,908 and 84.23 -> 82.37 against a floor of 82,
turning a 2.23-point margin into 0.37: one untested module short of a red nightly that would have
read as a regression rather than as scope growth. Its covered score held (85.79 -> 85.56), so
nothing stopped being pinned, and the floor drops to 80. Each floor now records the version that
measured it, and `docs/internal/mutation-testing.md` makes a Stryker major a re-measure, because a
floor is only a fact about the mutator set behind it.

**The unchanged deploy image was republished, and a guard now stops the next one.** #2076's
changeset listed `@cat-factory/deploy-harness` while nothing in that package moved, and its version
IS the deploy image tag. Release #2077 consumed that changeset before the correction could land, so
`cat-factory-deploy` went 0.2.15 to 0.2.16 with only a CHANGELOG and a version field behind it, and
every pin rolled to a tag naming a byte-identical image. That is spent; versions do not go
backwards, so 0.2.16 stands.

What is fixable is the recurrence. `scripts/check-image-harness-changesets.mjs` refuses a changeset
that versions an image harness when nothing that goes into that image changed on the branch. It is
the exact converse of `check-runner-image-tag.mjs`, which asks whether a source change bumped the
tag; neither direction implies the other, and both are silent when violated. The incident replays
as its first fixture.

Two claims in the previous release's changelog entry are wrong and are corrected here rather than
rewritten there, since that entry is published history: Stryker 10's only breaking change was not
the Node 20 drop, and `@cloudflare/workers-types` settles at an exact `5.20260815.1` rather than the
`^5.20260823.1` that entry names.
