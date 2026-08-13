---
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
'@cat-factory/agents': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
---

Record what a subscription run actually spent, snapshot an inline agent's context, and stop a
companion loop that has stopped converging.

Five defects a Kaizen grading surfaced, of which the grader itself correctly diagnosed one.

**Per-call output tokens were lost on every harness-served call.** Claude Code's `stream-json`
`assistant` envelopes carry the message-START usage snapshot: the input and cache counts are final,
`output_tokens` is the handful produced when the message opened, and `stop_reason` is null.
`attributeCumulativeUsage` was the intended rescue but guarded on whether ANY tokens had been
reported, which the input side always satisfies, so it stood down and the output side stayed at the
snapshot. Measured on a real board: a `coder` step recorded 198 output tokens against the 14,033 its
terminal event reported, an `initiative-analyst` 531 against 30,471, with the input side matching
exactly (which is what hid it). The shortfall is now computed PER SIDE, matching the rule the inline
path already applied. Cost accounting was never affected; per-call telemetry, the observability
panel, `/api/v1/debug/*` and the step rollups were.

The live-stream publisher had to change with it: it withheld only UNCOSTED calls, so with every turn
costed nothing was ever held, the last call streamed before attribution ran, and its first write won.
It now withholds exactly the last call, the only one attribution can rewrite.

**A finish reason nobody reported is no longer recorded as `stop`.** Both subscription CLIs expose
none, and three sites defaulted to `stop` anyway, which asserts the very thing a truncation check
tries to disprove and made `finishReason === 'length'` unfireable on that whole path. Absent is now
carried as absent, end to end.

**Inline agent kinds recorded no context snapshot at all.** `agent_context_snapshots` had exactly one
producer, the container executor, so every companion, judge, inline document kind and the requirements
reviewer was missing from it. The inline executor now files one through the same recorder, on both
facades.

**The Kaizen grader was fed two misleading figures**, and spent two of its six recommendations on
defects that did not exist. Its digest summed `promptTokens` alone, which is FRESH input by definition,
reporting 16 where the real input was 332,552; and it rendered a null finish reason as `unknown` beside
a flat "Truncated calls: 0". It now reports the three input classes and says outright when truncation is
unmeasurable. Its "no snapshot captured" line also stopped guessing a cause, having blamed a switch that
was enabled.

**A companion rework loop now stops when it stops making progress.** `attempts < maxAttempts` bounds how
long a loop may run and says nothing about whether it is converging: a run re-graded an unchanged
document to the same 0.76 four times, burning its whole budget. When the producer returns the text it
was asked to revise AND the rating does not move, the loop stops early and takes the same iteration-cap
exit, so an attended run parks for a person and an unattended one settles by policy. The step records
`stalled` beside `exceeded`, since only one of them means the remaining rounds were abandoned.
