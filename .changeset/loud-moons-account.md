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

**Every bad end carries its evidence.** `spawnCliExec` rejects with a `CliExecFailure` naming how
the run died (`timeout` / `aborted` / `exit`), and the vendor runner appends what its fold observed:
`claude timed out after 300000ms; silent for 69s; burned 1.45M tokens (1.40M cache-read) across 2
model calls`. When the model was never reached it says `no model call completed` — the distinction
the old message could not make, and the first fork in the road between a stalled CLI and one that
never got going. The enriched throw stays a `CliExecFailure`, so `reason` is readable on the error a
caller catches and not only one link down the `cause` chain.

**The stream is CONSUMED, never buffered.** `spawnCliExec` grew a `CliExecOptions.onLine` observer;
supplying one replaces body retention, and the claude runner feeds a stateful `ClaudeStreamFold`
that holds a bounded summary (per-call usage, the terminal event) rather than the stream. That is
load-bearing rather than tidy: `stream-json` output is unbounded in a way the one-shot `json` object
never was — every assistant envelope, every `tool_use` input and every tool_result, for as long as
the watchdog allows — and this runner bypasses permissions, so a stalled tool-using run would have
parked hundreds of MB in the orchestrator process, on precisely the runs this change exists to
diagnose. Only a bounded tail is kept, for the failure message. The container harness's `streamCli`
retains no body for the same reason. Because the fold outlives the rejection, the evidence no longer
has to ride on the error — which is also why the failure carries no output.

Two consequences of parsing what used to be an opaque body. Both streams are decoded with
`setEncoding('utf8')` rather than per-`Buffer`, since a multi-byte character split across a chunk
boundary decodes to replacement characters and these lines are handed to `JSON.parse` — one unlucky
boundary would have silently dropped an event, and its usage, from the fold. And the final line is
flushed on close, because it has no terminator in the two cases that matter: a clean run whose
terminal `result` event is the last thing written, and a killed one cut mid-JSON.

**Silence is measured rather than inferred from the exit.** Mirroring the container harness's
breadcrumb and its 30s threshold, so a fast failure gains no true-but-useless "said nothing"
clause. The wording claims only what this channel supports — the child's own stdout/stderr — so it
says "silent", not the harness's "no activity", which also counts keep-alive beats.

Envelopes are folded by `message.id` before summing. Claude Code emits one envelope per CONTENT
BLOCK, each repeating that one call's `usage`, so summing per envelope multiplies the burn: on the
run above, 117 envelopes carried 31 real calls and the naive sum inflated 1.47M tokens to 5.53M
(3.8x). `docs/initiatives/token-burn-instrumentation.md` records the container harness falling into
exactly this trap; `claude-call-aggregator.ts` is the fix it landed. Only usage that PARSES is
folded, so the call count means "calls that reported a burn" — counting envelopes that merely
carried a `usage` key would produce "burned 0 tokens across 3 model calls", contradicting the
`no model call completed` branch it sits beside.

Behaviour change worth flagging: local mode now invokes `claude` with `--output-format stream-json
--verbose`. A CLI build that doesn't support the streaming format would fail where it previously
succeeded.

Deliberately still open: the tokens are SURFACED, not ledgered. A failed step writes no
`token_usage` row on either transport, so the spend gate and quota rollups remain blind to them.
Closing that needs a failure-path recording seam in orchestration, which should cover the container
path in the same change rather than growing this one.
