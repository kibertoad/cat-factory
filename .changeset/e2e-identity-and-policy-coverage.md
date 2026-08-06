---
'@cat-factory/app': patch
---

Cover the front door and the three policies that decide what lands, end to end

Four surfaces the product cannot be used without had no browser coverage, and each fails in the one
direction a test suite is supposed to catch: silently, in production, on someone else's behalf.

- **Sign-in.** The whole suite ran with authentication OFF, so the one screen every user of a hosted
  deployment passes through was untested, and its failure mode is the worst in the product: nobody
  gets in and nothing says so. The spec drives the real form (gate, refusal, sign-in, reload,
  sign-out) and asserts the live WebSocket connects for the session too, which is the only assertion
  that separates a session good enough for REST from one good enough for the stream.
- **The merge policy.** The auto-merge ceilings are the one setting that decides, unattended, whether
  an agent's work lands on the default branch, and neither the library in Workspace Settings nor the
  per-task picker was covered. `merge-review.spec` looked like coverage but reaches its refusal by
  making the AGENT report a bad diff, so nothing in it depends on the policy at all: a panel that
  dropped a field or wrote percentages where fractions were expected would leave it green while
  auto-merging what an operator had forbidden. The new spec hands the merger the SAME assessment
  twice and changes only the policy, so the two outcomes ARE the policy.
- **Access administration.** `rbac.spec` proves a viewer's board and an admin's board render
  differently, but it seeds both roles into the database. The act itself (a role changed, a member
  removed) was uncovered, and the proof of it is what a DIFFERENT signed-in user's browser then
  renders, so each test spends a second context booted after the change.
- **Quorum and named approvers.** "Two people must sign off, and only these people may" is the shape
  a team uses for anything that ships. Every way it can break is invisible: a quorum that counts one
  person's two clicks, a policy saved against the wrong step index, a refusal enforced only in the
  SPA. Three signed-in people now drive one parked step.

The last two need identities the browser can see, and the suite's backend deliberately has none: its
`TESTING_NO_AUTH` opt-in is what lets 40-odd specs seed over anonymous REST, and under it the SPA
renders the board anonymously and never resolves a user, so a gate policy that names people refuses
everybody. Rather than fork the backend, the e2e process now serves a SECOND HTTP surface with
`config.auth` on (the same container, one engine, one worker) and a second instance of the same SPA
build pointed at it. Two properties of the product made that cheap and are worth knowing: `authConfig`
reads `container.config.auth` per request, so an auth-enabled deployment is a config clone rather than
a second wiring; and the SPA's Nitro shell re-reads `NUXT_PUBLIC_API_BASE` at startup, so a second
origin costs a process rather than a second (slowest-step) build. The one thing that is not free is
the WebSocket hub, which `start()` keeps to itself, so engine events are teed into both listeners.

The SPA changes are `data-testid` hooks the specs select through, plus one attribute worth calling
out: the risk-policy picker's hook lived on its DEFAULT trigger, which the inspector replaces via the
`#trigger` slot, so the inspector's own picker had no hook at all. Selecting the merge policy a task
runs under was, until now, unreachable from a test.

The access-administration spec also found a real one, which is fixed here. A removed member's next
visit still carries the persisted pin for the board they just lost, and the boot watcher loads the
model catalog for whatever that pin says before `init()` has validated it, so the gate's 404 escaped
as an uncaught rejection in the page. Every other boot read of the unvalidated pin already tolerates
the miss (init's own speculative snapshot fetch, the GitHub probe, the stream ticket mint); the
catalog load now says so too, through `models.prefetchForBoard`, which keeps the store UNLOADED on a
miss so the failure reads as unresolved rather than as a board with no AI configured.
