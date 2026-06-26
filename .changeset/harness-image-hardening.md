---
'@cat-factory/executor-harness': patch
---

Harden the executor-harness image + runner (image bump 1.15.2 -> 1.15.3):

- **Pin the base image by digest.** Both Dockerfile stages now pin
  `node:26-trixie-slim` to its multi-arch index digest
  (`sha256:a1d9d671…`) instead of the mutable tag, so two builds of the same
  Dockerfile always resolve the identical base (supply-chain / reproducibility).
  The human-readable tag is kept in the line for context; bump both stages
  together via `docker buildx imagetools inspect node:26-trixie-slim`.
- **Consolidate credential redaction into one module (`src/redact.ts`).**
  Previously the git/runner paths applied only the pattern-based scrub (URL
  userinfo + GitHub token shapes) and the subscription paths applied only the
  value-based scrub (the leased token + harvested JSON leaves), on disjoint error
  paths — so a secret only one rule caught could leak on the other. The single
  `redact(text, knownSecrets?)` now applies BOTH rules in one pass everywhere.
- **Watchdog headroom.** Derive the per-git-command timeout (`GIT_TIMEOUT_MS`) from
  the configured inactivity watchdog — a fixed 3-min margin below it, floored — instead
  of a constant racing it. Git emits no activity events while it runs, so an equal
  threshold made a slow clone/push fail with the misleading "no agent activity … likely
  hung" reason; git now always loses the race and surfaces its own accurate "git timed
  out". Deriving it (rather than hardcoding 7 min against the 10-min default) keeps the
  invariant intact even when an operator lowers `JOB_INACTIVITY_MS`. The invariant is
  documented on both constants.
- **Shared `killChildProcess` helper (`src/process.ts`).** Extract the identical
  SIGTERM→(5s)→SIGKILL escalation that the Pi and subscription CLI runners each
  re-implemented, so the kill strategy has a single source of truth.
