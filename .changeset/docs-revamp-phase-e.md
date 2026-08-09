---
---

Docs and CI guards only: the documentation revamp's largest phase, closing items 15, 16, 17 and 18
of `docs/initiatives/documentation-revamp.md`.

Item 17 decided that the website owns the integration-manifest FORMAT, which unblocked the two
reductions parked on it (`runner-pool-integration.md` §3 and `environments-integration.md`'s manifest
half). All ten pointerless "mixed" docs gained the pointer their classification claimed they had, and
the three with no destination (`auth.md`, `reusable-operations.md`, `figma-claude-design-context.md`)
were reduced once catfactory.ai's phase E landed their pages.

`scripts/check-doc-links.mjs` (item 16) closes the last unguarded link class: an ordinary relative
markdown link between repo docs, which no existing guard opened, so `git rm`ing a doc was green.
Twelve live breakages are fixed, six of them at initiative trackers that converted to ADRs. Generated
CHANGELOGs are out of scope as frozen history. `headingSlug` now strips inline markup, because `_`
survives GitHub's punctuation drop and made a heading ending `_(Application team)_` unlinkable.

A follow-up pass measured the result and found the reductions had not kept up with the pages: five
docs cut by 614 lines against 1,139 lines of new website pages, with fourteen mixed docs still
carrying full prose under a fresh pointer. Three more reductions followed, two of them needing a
website page first (`extend/tool-servers.md`, `operate/debugging-a-run.md`): `mcp-tool-servers.md`
723 → 347, `debug-api.md` 433 → 207, `document-sources.md` partly. The mixed-doc corpus is now
7,386 → 6,200 lines. Item 15 is REOPENED with eleven docs named as unread rather than ticked closed
over them.
