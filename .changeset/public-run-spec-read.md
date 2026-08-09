---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

`/api/v1` gains `GET /api/v1/runs/{runId}/spec` at `read` scope: the in-repo specification a run was
judged against, read at the branch that run pushed its work to. Additive, so the OpenAPI surface
version moves to 1.36.0 and nothing existing changes shape, scope or error vocabulary.

It is the sibling `GET /api/v1/services/{serviceId}/spec` could not stand in for. That one answers
the repository's default branch, and a task's spec increment does not merge while its pull request
is open, so a caller joining `requirements` rows from `…/report` or `…/outcome` back to the criteria
they were scored against found no criterion for exactly the rows the run had added. The pair mirrors
the internal split the SPA's outcome card already needed for the same reason.

Both public reads and both internal ones now go through one reader, and the run read goes through
the engine's own evidence loader, so the tree a caller joins against is the tree the platform joined
against: the same branch rule, the same tester gate and the same per-run memo the verification
report and the outcome summary use.

The loader change worth knowing about is that it now reports WHERE a spec read stopped instead of
folding every outcome onto an empty view. The two reductions still fold (a coverage section states
its own absence), but the endpoint does not: an unwired integration and an unreadable repository are
`503`s carrying their own `details.reason`, and a fourth `anchor` value, `not_read`, says the
platform has consulted no tree for this run yet. Folded, an outage would have told an integrator
that a run was judged against a service declaring no requirements.

The read also resolves the branch head before walking, which adds one repository call per run
(memoised with the tree, so a later reader gets the commit the tester ruled at rather than one
resolved afterwards).
