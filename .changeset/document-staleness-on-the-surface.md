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
clear it. The fresh outcome is still stored, so the dispatches that follow inherit it.

`syncedAt` and the verdict stay two facts. The stamp is when the body was last WRITTEN, and a
refresh that finds nothing changed writes nothing, so folding the check into the stamp would either
claim a write that never happened or leave a confirmation sitting on a row the source has since
moved past. An absent verdict therefore means "nobody has asked", never "unknown": listing
documents deliberately probes nothing, because confirming costs a round trip per page and a
board-wide sweep is a rate limit waiting to happen.

Two shapes worth noting for a reviewer. The freshness vocabulary moved from kernel to
`@cat-factory/contracts`, since this is the point at which a human reads the same conclusion the
agent does and the backend does not localize prose; kernel keeps the agent-facing renderer and
re-exports the types, so nothing importing them changes. And the refresh route takes the narrow
`DocumentSourceKind` rather than a stored row's wider origin, so an `upload` is refused at the
schema: a 200 carrying "not applicable" would leave a caller unable to tell "this document has no
source" from "the check ran and found nothing to compare", which is the distinction the whole
vocabulary exists to keep.
