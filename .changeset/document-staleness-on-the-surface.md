---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': patch
'@cat-factory/app': minor
---

Let a person ask a document source whether the copy on the board is still the current one

Runs re-confirm every linked document against its source at dispatch, so an agent no longer builds
from whatever import happened to store. The person deciding whether to START a run still could not
see any of it: the board showed a title and an excerpt frozen at import time, so "is the frame I
just edited the one the agents will read" was unanswerable without opening Figma and comparing by
eye. The imported-documents list and a task's context panel now carry the `syncedAt` stamp and a
member-tier action that runs the same probe → compare → re-import ladder on demand, answering with
the refreshed row and what the check concluded.

The manual path drops the cached verdict before it asks, and that is the reason it is a separate
entry point rather than a second caller of the batch one. The 60-second cache exists so a
pipeline's worth of step dispatches costs one round trip per document and so a source that is down
is remembered as down instead of being re-probed by every dispatch; both are exactly wrong for a
click, whose commonest cause is that the last answer reported an outage. Served from the cache, the
button would report the very failure the person is retrying past and no amount of clicking would
clear it.

What a click may leave BEHIND in that cache is asymmetric, and the asymmetry is the whole safety
property. A success is stored, so the dispatches that follow a manual refresh inherit it. A failure
is not: the entry has just been dropped, so re-filling it with whatever one click found would let a
person retrying past a flaky source install an `unreachable` verdict every dispatch reads for the
rest of the TTL window, degrading the run path with a failure no dispatch ever observed and
renewing it with each further click. For the same reason a click never increments
`document.freshness_gap`: that counter measures runs handed a copy the source has moved past, and
one person clicking through an outage could otherwise move a deployment-wide rate as far as they
have patience for.

A moved REVISION is no longer reported as a changed document. `DocumentFreshness.confirmed` carries
a three-member `change` where it carried a `reimported` boolean, because a whole-file source
routinely moves its token without changing anything a reader sees: a Figma file's version bumps on
any edit anywhere in it, including frames a given document does not cover. That case now says so
(`revision_only`), and the write that records the moved token no longer moves `syncedAt`, which
means "when the body was last written" and would otherwise put a fresh timestamp on bytes nobody
changed. INTERNAL BREAK: the boolean is gone rather than kept beside the enum.

`syncedAt` and the verdict stay two facts. The stamp is when the body was last WRITTEN, and a
refresh that finds nothing changed writes nothing, so folding the check into the stamp would either
claim a write that never happened or leave a confirmation sitting on a row the source has since
moved past. An absent verdict therefore means "nobody has asked", never "unknown": listing
documents deliberately probes nothing, because confirming costs a round trip per page and a
board-wide sweep is a rate limit waiting to happen. Both facts are rendered WITH their time, since
each is a claim about a moment in the history of a page someone else is still editing and a moment
stated without its time is read as "now". A verdict is also scoped to the BOARD it was asked on: the
same file can be imported into two of them, and a verdict keyed by source and id alone would render
one board's confirmation against another board's row that nobody had checked.

Two shapes worth noting for a reviewer. The freshness vocabulary moved from kernel to
`@cat-factory/contracts`, since this is the point at which a human reads the same conclusion the
agent does and the backend does not localize prose; kernel keeps the agent-facing renderer and
re-exports the types, so nothing importing them changes. And the refresh route takes the narrow
`DocumentSourceKind` rather than a stored row's wider origin, so an `upload` is refused at the
schema: a 200 carrying "not applicable" would leave a caller unable to tell "this document has no
source" from "the check ran and found nothing to compare", which is the distinction the whole
vocabulary exists to keep.
