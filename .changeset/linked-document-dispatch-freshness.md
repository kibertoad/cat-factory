---
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/caching': minor
'@cat-factory/observability-otel': minor
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
the source's version, compare it against the token the stored body came from, and re-import only what
actually moved. That comparison needed something to compare to, which the row did not have, so
`documents.source_version` is new. It is part of the idempotent-reimport comparison even though no
agent reads it: a Figma file version bumps on any edit anywhere in the file, so leaving a stale token
on an unchanged body would re-download the whole design on every dispatch, forever. NULL covers three
cases that all mean "cannot be proven current" and all self-heal on one re-import: an upload, a
source exposing no version, a row predating the column.

Three things bound the cost, each a different half of it. The new short-TTL `linkedDocumentVersion`
cache holds the OUTCOME of the whole ladder rather than the body or just the probe, so a burst of step
dispatches costs one round trip per document, concurrent dispatches of one document dedupe onto a
single download, and a source that is DOWN is remembered as down instead of being re-asked by every
dispatch for as long as the outage lasts (a cache loader that throws caches nothing, which is why the
failure is a value). It has no refresh window, since the load already is the check. The workspace's
connection is resolved ONCE per pass for the whole corpus through a new batched
`resolveConnections`, not per document and again inside each probe. And the per-document fan-out is
bounded, because a task can attach a corpus budget's worth of Figma frames and each miss expands into
chunked per-frame node reads. Coherence is invalidation plus the TTL: connect/disconnect drops the
workspace group, a manual import drops that document's entry. The entry stays enabled on the Worker's
isolate-safe profile, since an external version token is neither our own mutable state nor in need of
a bus to heal.

The ladder also has to CONVERGE, which took one non-obvious hop: `reimport` records the caller's
probed token when the source's own fetch exposes none. A provider may resolve its version best-effort
inside `fetchDocument` (GitHub docs' commit sha degrades to null on a rate-limited request) while its
cheap probe still answers, so the row was left holding null, mismatched the probe on every future
dispatch, and re-downloaded the whole document forever while reporting "this source has no revision"
about a source that plainly has one.

Freshness reaches the agent as a header line, and it is a three-way verdict rather than a boolean.
`confirmed` contributes `Revision: <token>`, so "which revision did this run build against" is
answerable from the checkout afterwards. `not-applicable` renders nothing: an upload has no source to
trail, so a staleness warning there would invent a problem. `unconfirmed` warns and names which of
four gaps applies, because "reconnect the source", "wait out the outage", "this source has no revision
to compare" and "this deployment cannot read the credential" are four different fixes and one merged
"unknown" sends the reader at the wrong one. The last of those is mothership mode, not a defensive
branch: a node with no main database cannot read a connection sealed with the mothership's key, so the
read fails permanently and by design, and calling that an outage would send an operator hunting a
Figma incident that does not exist. One renderer serves both surfaces a document reaches (the
materialised `.cat-context/` file and the in-prompt injection an INLINE kind gets instead of a
checkout), because a judge or reviewer scoring against a stale design is the same failure as a
container agent building from one, and an omitted note reads exactly like a copy that was checked.
Every gap also increments the new `document.freshness_gap` counter, dimensioned by reason and source:
each of these conditions repeats per dispatch while it lasts, so the log line answers "what happened
to this run" and only a rate answers "is this spreading". The refresh still never throws, so a source
outage costs the run a stale body and a stated warning rather than the run, and the readability
refusal now runs on the refreshed records, since a page emptied since import is the case most worth
refusing. That
includes the REQUIREMENTS REVIEW, the first step of the default pipelines and the one a human signs
off on, which resolves its attachments through the same refresher rather than reviewing the
import-time copy while the coder two steps later builds from the current one. A deployment with no
refresher wired gets no verdict at all rather than a synthesised one: it did not conclude these bodies
are unverifiable, it never asked.

Separately, the one fragment that tells an agent how to consume design context was selected by nothing.
Its `appliesTo` selector is a management-surface hint the run path never drove, it is in no seed pin
set, and basic mode hides the per-task fragment picker — so the standard case, a designer links a frame
and starts a run, executed with a design context file on disk and no instruction anywhere to honour it.
The engine now folds it whenever the run's resolved context carries a design-origin document. The
trigger is the document rather than the block type, which the retired selector got wrong in both
directions (it missed a design linked to an unlabelled task and fired on a frontend task with no
design), and that selector is DELETED rather than left beside the new rule: the deterministic
selector and the management surface still read it, so leaving it would keep labelling the fragment
frontend-only while the engine folded it for anything carrying a design. It rides the normal fold, so
a workspace override still wins and the two-tier brief/full verbosity still applies. The flag settles
off the corpus read rather than off the finished linked context, so the fragment fold (an LLM call,
when a standard needs condensing) is not serialised behind a live source probe on every dispatch.

Two hygiene fixes ride along, both about a claim over a pasted URL. `makeDocumentUrlResolver` now
consults host-pinned parsers before host-blind ones instead of in registration order: Notion's
`parseRef` claims any UUID-shaped run anywhere, so registered first it stole a Figma URL whose file key
carried one, and the point lookup then searched the wrong key space and found nothing — a linked design
reaching the agent as no context at all. And the two source traits that decide these things
(`isDesignSource`, `isHostPinnedSource`) live in contracts off one exhaustive `Record`, because the SPA
has to label a design source too and the run path reads them where no provider is reachable.

Reviewing: the refresh sits on the hot path of every dispatch, so the thing to check is the ladder's
short-circuits (an unchanged design must cost one cached round trip and no download, a failed one must
not be retried per dispatch, and the second dispatch after a re-import must do nothing at all) rather
than the verdicts. The re-import running INSIDE the cache loader is the deliberate part: it is what
lets one entry bound the expensive half and dedupe concurrent dispatches, and its consequence is that
a caller which deduped onto someone else's outcome re-reads the row rather than labelling the body it
already holds with a revision it does not carry. The `sourceVersion` column is nullable on purpose and
a backfill would be wrong: an empty string cannot be told apart from a source that genuinely has no
version, and the two get different treatment.
