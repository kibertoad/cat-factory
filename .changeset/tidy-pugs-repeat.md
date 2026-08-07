---
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
'@cat-factory/mcp-server': patch
'@cat-factory/server': patch
'@cat-factory/sdk': patch
---

Stop the run-debug surface and the decision-list description from telling callers things that are
no longer true.

The `tool_retry_loop` signal handed the reader `?ok=false`, a tool-call filter replaced by
`?outcome=error`. An unknown query param is ignored rather than refused, so the link answered with
the run's WHOLE trajectory and a follower reading it as the failing subset saw every call as a
failure. Now pinned by a test, which is what was missing when the param was renamed.

`listPublicRunDecisions` described two decision kinds out of the thirteen the response can carry,
and claimed `parked` gates the list. It does not: a `follow-ups` entry is answerable while the run
is still working, so a caller that polls only when `parked` waits for a stop that never comes. The
regenerated description names every kind and points an empty `decisions` at `unanswerable`. It
reaches the spec, the four SDK clients and the MCP tool descriptions, which is the surface LLM
callers read instead of the docs.
