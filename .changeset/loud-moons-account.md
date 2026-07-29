---
'@cat-factory/local-server': minor
---

Make a killed inline CLI run account for what it spent.

A local-mode `doc-researcher` step failed with `claude timed out after 300000ms` and nothing else.
Four attempts had actually run — 31 model calls, 1.47M tokens, 1.32M of it cache-read — and every
one of them was billed and recorded nowhere: a failed step writes no `token_usage` row on either
transport. So the run read as idle. `agent_runs` sat at `rev=1`, no container was alive, no usage
existed, and the only surviving account of what the agent had done was the CLI's own session
transcript under the developer's `~/.claude`. Concluding "it was working the whole time" took
mining that transcript by hand.

Two gaps lined up. The watchdog and abort paths rejected with the bare fact that the budget had
elapsed, discarding the stdout they were holding — the same defect the previous fix addressed for
the non-zero-exit path and left untouched on these two. And the runner took `--output-format json`,
whose single result object exists only if the CLI reaches the END, so a killed run had no usage to
recover even in principle.

**The inline `claude` runner streams.** `--output-format stream-json --verbose`, as the container
harness already runs it, instead of the one-shot `json`. The terminal `result` event carries the
same fields the single object did, so the success path is unchanged and still treats the CLI's own
cumulative figure as authoritative; the difference is that a killed run now leaves a partial stream
to account for itself with.

**Every bad end carries its evidence.** `spawnCliExec` rejects with a `CliExecFailure` holding the
kill reason and the partial stdout, and the vendor runner appends what that stream reports:
`claude timed out after 300000ms; silent for 69s; burned 1.45M tokens (1.40M cache-read) across 2
model calls`. When the model was never reached it says `no model call completed` — the distinction
the old message could not make, and the first fork in the road between a stalled CLI and one that
never got going.

**Silence is measured rather than inferred from the exit.** Mirroring the container harness's
breadcrumb and its 30s threshold, so a fast failure gains no true-but-useless "said nothing"
clause. The wording claims only what this channel supports — the child's own stdout/stderr — so it
says "silent", not the harness's "no activity", which also counts keep-alive beats.

Envelopes are folded by `message.id` before summing. Claude Code emits one envelope per CONTENT
BLOCK, each repeating that one call's `usage`, so summing per envelope multiplies the burn: on the
run above, 117 envelopes carried 31 real calls and the naive sum inflated 1.47M tokens to 5.53M
(3.8x). `docs/initiatives/token-burn-instrumentation.md` records the container harness falling into
exactly this trap; `claude-call-aggregator.ts` is the fix it landed.

Behaviour change worth flagging: local mode now invokes `claude` with `--output-format stream-json
--verbose`. A CLI build that doesn't support the streaming format would fail where it previously
succeeded.

Deliberately still open: the tokens are SURFACED, not ledgered. A failed step writes no
`token_usage` row on either transport, so the spend gate and quota rollups remain blind to them.
Closing that needs a failure-path recording seam in orchestration, which should cover the container
path in the same change rather than growing this one.
