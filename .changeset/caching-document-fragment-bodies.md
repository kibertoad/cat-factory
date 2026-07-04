---
'@cat-factory/caching': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': patch
---

Cache document-backed prompt-fragment bodies through the app caching seam
(caching-layer initiative, slice 2). A new `AppCaches.fragmentDocumentBody`
group cache serves a living fragment's external Confluence/Notion/GitHub/Figma/
Zeplin/Linear body, replacing the hand-rolled `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`
in `FragmentLibraryService`: a run reads the cached body instead of blocking on a
live page fetch, and an entry entering its refresh window runs the source's cheap
version probe — keeping the cached body when the page hasn't moved, reloading in
the background when it has.

To support the probe, `DocumentContent` now carries an opaque `version` token and
`DocumentSourceProvider`/`DocumentContentResolver` gain a `probeVersion` method
(metadata-only, strictly cheaper than a full fetch), implemented across all
document providers. The self-verifying cache stays enabled on the Cloudflare
Worker (bounded staleness via the probe), unlike the mutable-state fragment
catalog.

Behavior change (pre-1.0, no back-compat): the durable `prompt_fragments.body` is
now the offline fallback + management-view content, refreshed only by an explicit
create/refresh; the live run-time body flows through the cache. Without a cache
wired, a run serves the persisted body and does not re-resolve live.
