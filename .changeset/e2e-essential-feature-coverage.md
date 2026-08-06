---
'@cat-factory/app': patch
---

Cover four essential product surfaces end to end (and instrument what they needed)

The Playwright suite had grown to 37 specs without touching four things the product cannot be used
without, each of them the kind of surface only the assembled product can fail on:

- **The pipeline builder.** Every spec created pipelines over REST, which is exactly the layer that
  cannot fail the way the builder does: it holds a draft as an ordered kind list plus parallel
  per-step flag arrays, assembles a save payload from them, and the engine reads those arrays back
  to decide where to stop. Nothing checked the three agree, and a flag written at the wrong index
  saves cleanly, lists correctly, and runs differently from the picture the human drew. The spec
  draws `architect → coder` with a gate on the FIRST step and asserts the run parks on the
  architect.
- **Deep PR review**, in both of its dispositions. What a human curates is what reaches the pull
  request, and that curation exists only in this window: dismiss a false positive, deselect a
  finding, publish the rest, read the report back. A second spec drives the PARTIAL post, where one
  comment is refused: the run is handed back carrying the report rather than finished, and the retry
  sends only what did not land. That last rule is asserted on the WIRE (the review writes the
  backend actually made), because the window's own report reads identically for a retry that
  re-posted a comment already on the pull request.
- **The run outcome card** ("read the result"), which in basic mode is what a finished task's one
  result affordance opens. Its failure mode is a section reading CLEAN because a producer's output
  never arrived.
- **Board switching**, the affordance every other spec bypassed by pinning a board client-side, and
  the one that has to move the live WebSocket subscription. A stale subscription looks perfectly
  healthy (the new board renders from the REST snapshot) and only later updates go missing.

The SPA changes are `data-testid` hooks the specs select through (the suite's selector rule): the
agent palette's per-kind add buttons, the builder's name field, draft step rows (with their kind and
gate state) and per-step gate toggle, the board switcher plus its per-board menu rows, and the step
detail's own agent KIND. That last one is an attribute rather than a hook on the heading beside it,
because the heading is translated display copy: reading it would tie a test to wording, and to
English.

Three backend-fixture notes for whoever writes the next spec, all now in the suite README. A
`Service` is ACCOUNT-owned, so two specs importing the same repo get one frame that belongs to
whichever workspace imported it first (`seedOwnRepo` exists for that). The run/repository seam is
wired as a scoped override rather than the facade's production resolver: the seeded board has no
repo-linked frame, and the production walk THROWS for a block under none (deliberately, so a run
never guesses a repository), which fails the poll of every seeded run whose kind declares repo
hooks. And the faked provider answers for ONE pull request and refuses ONE anchor once, so a run
pointed at the wrong PR fails instead of quietly reviewing the same canned diff, and the
partial-post path is reachable at all.
