---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Feed the visual-confirmation gate from the designs a task links. The frames an import retained for
a linked Figma/Zeplin document now populate the gate's actual-vs-reference gallery on their own, so
a designer who linked a frame gets screenshot-vs-design comparison with no manual upload at all.

A reference that was explicitly chosen for a view still wins: an upload is a deliberate act against
that one task and survives every re-import, while a design render is a projection the next
body-changing import replaces wholesale. So an upload assigns over the fold, and a view whose
reference the capture itself named is left alone. Each pair now says which of the two it is showing,
and says nothing when the capture named its own, because a reference the gate did not source is one
whose provenance it can only guess at.

A view name two designs both claim is qualified with its design on BOTH sides rather than just the
second, the same rule the Figma import applies to a frame name repeated across pages: leaving the
first bare would hand the plain name to whichever design is listed first, and re-ordering the links
would then silently re-point a reviewed view at a different screen.

The gate also states what the linked designs contributed whenever a design is attached, including
when everything worked, so "no design is linked" stays distinguishable from "one is and it gave
nothing". The latter carries a per-design reason, since retaining part of a design, failing to
download it, having no frames at all, and having had nowhere to store them each ask for a different
fix. That verdict is derived from what the artifact store actually holds rather than from the
recorded render status alone, so any status claiming retention over an empty shelf reports the
absence rather than describing a gallery that is not there. The gallery's ceiling on design views is
shared round-robin across the linked designs instead of being spent in read order, and each design
that loses frames to it is named, so a design the ceiling shut out cannot read as one with no
frames.

Gathering the pairs no longer confuses a gallery ROW with a captured screenshot. A reference-only row
(a design frame, an uploaded mock) makes a pair too, so a run that captured nothing had been losing
the warning that gates the gate's approve button behind an acknowledgement, reporting a verified
gallery of blanks in its run outcome, and summoning reviewers to screenshots that were not there. The
rule now lives once in `@cat-factory/contracts` and all three ask it.

`BinaryArtifactStore` grows a batched `listByDocuments`, mirrored D1 ⇄ Drizzle with a conformance
assertion and allow-listed for mothership mode, so a task linking several designs still costs the
driver path one read.
