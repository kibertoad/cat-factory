---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Run the spec-writer before the architect, and give every agent in a pipeline one
shared work branch created up front.

- **Pipeline order**: in `pl_full` and `pl_fullstack` the `spec-writer` now runs
  *before* the `architect` (in `pl_fullstack`, the `spec-writer`/`spec-companion`
  pair moves ahead of `architect`/`architect-companion`). The architect is
  spec-aware, so it now designs against the just-written in-repo `spec/` instead of
  writing the spec only after the design is settled. Human gates are unchanged
  (requirements review, spec, architecture).

- **Shared work branch**: the per-task work branch (`cat-factory/<blockId>`) is now
  created programmatically before the container agents run, via a new optional
  `ensureWorkBranch` dependency on `ContainerAgentExecutor` (wired in both the
  Cloudflare and Node facades through `ensureWorkBranchViaRest`). Every agent —
  including the read-only design agents (architect, analysis) — operates on that one
  branch, so the architect reads what the spec-writer committed. Creating the branch
  is idempotent and best-effort; when GitHub is not wired (tests), read-only agents
  fall back to the base branch as before.
