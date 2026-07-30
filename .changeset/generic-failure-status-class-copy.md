---
'@cat-factory/contracts': minor
'@cat-factory/kernel': patch
'@cat-factory/app': minor
---

Describe a non-conflict API failure from its STATUS CLASS in translated copy, and keep the raw
backend prose behind a "Show details" disclosure.

`usePipelineErrorToast` is the funnel every failure that is not a 409 drains into, and it put the
backend's `message` straight into the toast description. Three things followed from that, all of them
visible to a user:

- **A non-English user read English.** The whole point of the `reason`-code contract is that the
  backend emits a code and the SPA translates it; every non-conflict failure sidestepped it.
- **An internal 500 explained nothing.** `handleError` deliberately answers a fault with the fixed
  `Internal server error` and never the thrown text, so the description WAS that sentence.
- **A request-validation 400 dropped the only informative part.** Its message is the fixed
  `Request failed validation`; the `issues` array naming the offending fields was parsed by nobody.

The description is now translated copy keyed off `error.code` through an exhaustive
`Record<Exclude<ApiErrorCode, 'conflict'>, string>`, and the untranslated detail — the prose, the
validation `issues`, and the envelope's `requestId` — is revealed in place by a button. Keeping the
prose reachable is the point rather than a concession: the elaborate operator remedies this initiative
spent eighteen slices adding (a `configProblem` remedy, `describeVcsApiError`'s appended cause, a
harness `HarnessFailure` remedy) are exactly what someone pastes into a bug report. What changed is
that a raw string is no longer the FIRST thing anyone reads.

`requestId` reaches a screen for the first time. `handleError` has stamped it on every envelope since
request logging landed, specifically so a user could quote it back and an operator could grep the one
line that explains their failure — and no SPA surface had ever rendered it.

**The status class moves to `@cat-factory/contracts`.** `DOMAIN_ERROR_CODES` is now declared there and
kernel's `DomainErrorCode` is derived from it, mirroring how `ConflictReason` already worked: it is a
shape both sides read, so a status class added on one side must be honoured on the other, and the
frontend `Record` becomes a real drift guard instead of a hand-kept list. `API_ERROR_CODES` adds
`internal` on top, because that code is minted by the error handler and produced by no `DomainError` —
a client mapping only the domain codes silently misses every 500, which is how this gap started.

Two verdicts are kept apart on purpose. "Nothing answered" (no envelope and no HTTP status: offline,
DNS, a dropped connection) and "something answered unrecognisably" (a proxy's 502 page, a `code` this
build does not know) get different copy, because their remedies are opposites — check your connection
versus the server is broken — and one wording for both would be a cause inferred rather than reported.

No backend behaviour changes: the wire shape, the codes and the messages are all untouched, and the
kernel change is a type re-export. Section H of the error-message-coverage initiative (making the
remaining providers UI-configurable) is the only part of it still open.
