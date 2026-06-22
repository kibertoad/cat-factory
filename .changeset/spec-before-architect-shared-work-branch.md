---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Run the spec-writer before the architect, and give every agent in a pipeline one
shared work branch created up front.

- **Pipeline order**: in `pl_full` and `pl_fullstack` the `spec-writer` now runs
  _before_ the `architect` (in `pl_fullstack`, the `spec-writer`/`spec-companion`
  pair moves ahead of `architect`/`architect-companion`). The architect is
  spec-aware, so it now designs against the just-written in-repo `spec/` instead of
  writing the spec only after the design is settled. Human gates are unchanged
  (requirements review, spec, architecture).

- **Shared work branch**: the per-task work branch (`cat-factory/<blockId>`) is now
  ensured before the container agents run, via a new optional `ensureWorkBranch`
  dependency on `ContainerAgentExecutor` (wired in both the Cloudflare and Node facades
  through `ensureWorkBranchViaRest`). Every agent — including the read-only design agents
  (architect, analysis) — operates on that one branch, so the architect reads what the
  spec-writer committed. The helper probes first (an existing branch is reported ready in
  a single call), and only _writers_ create the branch from base when absent — read-only
  agents probe only, so a code-less pipeline never orphans an empty ref. It is idempotent
  (a 422 race is success) and best-effort, but now logs a warning on every failure path so
  a fallback to the base branch is observable rather than silent; ref names with slashes
  are encoded per path segment. When GitHub is not wired (tests), read-only agents fall
  back to the base branch as before.
