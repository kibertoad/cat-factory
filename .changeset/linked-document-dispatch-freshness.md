---
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/caching': minor
'@cat-factory/prompt-fragments': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

An agent now builds against the current design, and is told how to read it

A linked document was frozen at import time. `probeVersion` existed on every provider and had exactly
one caller (the fragment-library body cache); nothing on the run path ever looked at the source again.
So a Figma frame edited after import fed every later run the old markdown, with the run reading as
perfectly healthy. For a requirements page that is an annoyance; for a design under active iteration
it means the agent routinely builds the previous revision.

The linked-context resolution path now re-confirms each document at dispatch, through the kernel
`LinkedDocumentRefresher` port. The cost model is the design, because that path runs per STEP: probe
the source's version (served through a new short-TTL `linkedDocumentVersion` cache, so a burst of step
dispatches costs one probe per document), compare it against the token the stored body came from, and
re-import only what actually moved. That comparison needed something to compare to, which the row did
not have, so `documents.source_version` is new. It is part of the idempotent-reimport comparison even
though no agent reads it: a Figma file version bumps on any edit anywhere in the file, so leaving a
stale token on an unchanged body would re-download the whole design on every dispatch, forever. NULL
covers three cases that all mean "cannot be proven current" and all self-heal on one re-import — an
upload, a source exposing no version, a row predating the column.

The cache holds the PROBE, not the body, and has no refresh window: the load already is the cheap
probe, so there is nothing cheaper to re-validate an entry with, and caching the body instead would put
a whole-file Figma download (chunked per-frame node reads) on the critical path of any dispatch that
missed. It stays enabled on the Worker's isolate-safe profile, since an external version token is
neither our own mutable state nor in need of a bus to heal.

Freshness reaches the agent as a header line on the materialised context file, and it is a three-way
verdict rather than a boolean. `confirmed` contributes `Revision: <token>`, so "which revision did this
run build against" is answerable from the checkout afterwards. `not-applicable` renders nothing: an
upload has no source to trail, so a staleness warning there would invent a problem. `unconfirmed`
warns and names which of four gaps applies, because "reconnect the source", "wait out the outage",
"this source has no revision to compare" and "this deployment cannot read the credential" are four
different fixes and one merged "unknown" sends the reader at the wrong one. The last of those is
mothership mode, not a defensive branch: a node with no main database cannot read a connection sealed
with the mothership's key, so the read fails permanently and by design, and calling that an outage
would send an operator hunting a Figma incident that does not exist. The refresh never throws — a
source outage costs the run a stale body and a stated warning, never the run — and the readability
refusal now runs on the refreshed records, since a page emptied since import is the case most worth
refusing. A deployment with no refresher wired gets no
verdict at all rather than a synthesised one: it did not conclude these bodies are unverifiable, it
never asked.

Separately, the one fragment that tells an agent how to consume design context was selected by nothing.
Its `appliesTo` selector is a management-surface hint the run path never drove, it is in no seed pin
set, and basic mode hides the per-task fragment picker — so the standard case, a designer links a frame
and starts a run, executed with a design context file on disk and no instruction anywhere to honour it.
The engine now folds it whenever the run's resolved context carries a design-origin document. The
trigger is the document rather than the block type, which the retired selector got wrong in both
directions (it missed a design linked to an unlabelled task and fired on a frontend task with no
design). It rides the normal fold, so a workspace override still wins and the two-tier brief/full
verbosity still applies.

Two hygiene fixes ride along, both about a claim over a pasted URL. `makeDocumentUrlResolver` now
consults host-pinned parsers before host-blind ones instead of in registration order: Notion's
`parseRef` claims any UUID-shaped run anywhere, so registered first it stole a Figma URL whose file key
carried one, and the point lookup then searched the wrong key space and found nothing — a linked design
reaching the agent as no context at all. And the two source traits that decide these things
(`isDesignSource`, `isHostPinnedSource`) live in contracts off one exhaustive `Record`, because the SPA
has to label a design source too and the run path reads them where no provider is reachable.

Reviewing: the refresh sits on the hot path of every dispatch, so the thing to check is the ladder's
short-circuits (an unchanged design must cost one cached probe and no download) rather than the
verdicts. The `sourceVersion` column is nullable on purpose and a backfill would be wrong: an empty
string cannot be told apart from a source that genuinely has no version, and the two get different
treatment.
