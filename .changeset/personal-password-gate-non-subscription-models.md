---
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Don't prompt for a personal password when running a non-subscription model.

The individual-usage credential gate resolved its vendor set without honouring that a
block's pinned model wins for every step. A block pinned to a non-subscription model
(Cloudflare / Bedrock / a direct provider) still fell through to the workspace per-kind
defaults, so when any workspace default was an individual-usage model (Claude / GLM /
Codex) the run was gated on a personal password the run would never actually use. Now a
resolvable block pin alone decides the vendor set — its individual vendor, or none for a
non-subscription model — exactly mirroring the dispatch-time precedence in
`resolveStepModelRef`; only an unpinned run consults the workspace defaults. The
precedence is extracted into a pure `resolveIndividualVendors` with unit coverage.

Also: the board now shows an empty-state invite (bootstrap a repo / add from an existing
repo) when it has no service frames, instead of a blank canvas.
