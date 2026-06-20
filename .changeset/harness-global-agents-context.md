---
'@cat-factory/executor-harness': patch
---

Write the agent's composed system prompt to Pi's **global** context file
(`~/.pi/agent/AGENTS.md`, alongside the existing `models.json`) instead of into
the repo checkout (`<repo>/AGENTS.md`). The instructions already travel headlessly
in the job body — only the harness→Pi hop went through a file in the working tree.
Moving it out-of-tree means it can never be committed into a PR (across run,
ci-fix, bootstrap, and blueprint), and a repo's own committed `AGENTS.md` is now
read and concatenated by Pi rather than clobbered/overwritten. Removes the
scattered `AGENTS.md` special-casing in `hasAgentChanges`, the bootstrap no-op
check, and the benchmark diff exclusion. Changes the image, so the harness version
(its GHCR/registry image tag) bumps with it.
