---
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
'@cat-factory/agents': patch
'@cat-factory/kernel': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
---

Record what a subscription run actually spent, snapshot an inline agent's context, and stop a
companion loop that has stopped converging.

Five defects a Kaizen grading surfaced, of which the grader itself correctly diagnosed one.

**Per-call output tokens were lost on every harness-served call.** Claude Code's `stream-json`
`assistant` envelopes carry the message-START usage snapshot: the input and cache counts are final,
`output_tokens` is the handful produced when the message opened, and `stop_reason` is null. The
reconciliation against the terminal cumulative total was the intended rescue but guarded on whether
ANY tokens had been reported, which the input side always satisfies, so it stood down and the output
side stayed at the snapshot. Measured on a real board: a `coder` step recorded 198 output tokens
against the 14,033 its terminal event reported, an `initiative-analyst` 531 against 30,471, with the
input side matching exactly (which is what hid it). The shortfall is now computed PER SIDE, and it is
filed as its OWN row standing for the job rather than added to the last captured turn: a turn grown
by thousands of tokens it did not produce is a derived number that reads as a measured one on every
surface showing per-call figures. It is also reconciled against the PARENT loop's calls alone, which
matters in `ambientAuth` mode, where the CLI streams subagent turns onto the parent's stdout with no
transcript watcher to own them: those turns were both hiding the shortfall and, being last,
attracting it. Cost accounting was never affected; per-call telemetry, the observability panel,
`/api/v1/debug/*` and the step rollups were.

**A finish reason nobody reported is no longer recorded as `stop`.** Both subscription CLIs expose
none, and three sites defaulted to `stop` anyway, which asserts the very thing a truncation check
tries to disprove and made `finishReason === 'length'` unfireable on that whole path. Absent is now
carried as absent, end to end — including through the AI SDK boundary, whose closed union has no
"unknown" member, so its `other` placeholder with no vendor string behind it is read back as the
absence it stands for rather than as a classification.

**Inline agent kinds recorded no context snapshot at all.** `agent_context_snapshots` had exactly one
producer, the container executor, so every companion and inline document kind was missing from it.
The inline executor now files one through the same recorder, on both facades, and the dependency is a
required key with a nullable value so a facade that forgets it fails to typecheck rather than
silently recording nothing. The inline SERVICES that call `generateText` directly (the judges, the
requirements reviewer, Kaizen's own grader) still file none; that is named in the code and the docs
instead of being implied closed.

**The Kaizen grader was fed two misleading figures**, and spent two of its six recommendations on
defects that did not exist. Its digest summed `promptTokens` alone, which is FRESH input by
definition, reporting 16 where the real input was 332,552; and it rendered a null finish reason as
`unknown` beside a flat "Truncated calls: 0". It now reports the three input classes, and a
truncation count carries the number of calls that actually reported a reason on the same line, so a
"0" measured over one call in eight cannot read as a clean step. Its "no snapshot captured" line also
stopped guessing a cause, having blamed a switch that was enabled.

**A companion rework loop now stops when it stops making progress.** `attempts < maxAttempts` bounds
how long a loop may run and says nothing about whether it is converging: a run re-graded an unchanged
document to the same 0.76 four times, burning its whole budget. When the producer returns the text it
was asked to revise AND the rating does not move, the loop stops early and takes the same
iteration-cap exit, so an attended run parks for a person and an unattended one settles by policy.
The rule reads a step's reply as its work, so it applies only to producers whose deliverable IS that
reply: a `coder` pushes commits and may legitimately answer with nothing, which is why its reviewer
reads the real diff, and a rework a human asked for is excluded too (it spends none of the automatic
budget). The step records `stalled` beside `exceeded`, since only one of them means the remaining
rounds were abandoned, and the park says which one it is instead of claiming a limit was hit.
