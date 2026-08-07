---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
---

Close the three container-side holes in the "a job can never run forever" guarantee

The stuck-run audit found that every path out of a wedged run eventually hits some backstop, and
then found three places inside the container where the backstop that was supposed to catch it is
the one that cannot. All three are harness-side, so they land together as one image slice.

**The watchdogs run on the same event loop as the stream they watch.** Both abort timers and the
`/health` + `/jobs` poll endpoints share one Node event loop with the JSONL parsing hot path, and
both CLI readers had grown an unbounded framing buffer: a record that never terminates accumulates
without limit, and the close-of-run reductions then re-parsed the entire run's stdout two more
times. A container that stalls that loop stops answering polls while its own timers never fire,
which is precisely the wedge the timers exist to prevent, leaving only the engine's poll-failure
tolerance and the reaper underneath. Framing is now a shared `JsonlLineReader` that refuses to
buffer a runaway record, and the close path reduces the records it already parsed as they streamed.

A dropped oversized record is dropped whole rather than truncated, and counted: half a JSON
document is not a record, and handing the parser one would report the bound firing as corrupt
model output. The cap is on the record, not on the leftover buffer, so it cannot depend on how the
OS happened to split the reads. It sits far above the largest legitimate record (the terminal
transcript, whose loss would cost the run its summary), because this is a ceiling on wedging the
loop, not a size policy.

**A chatty model trips no guard at all.** The inactivity watchdog resets on any output, and the
no-progress guard counts tool calls, so a model that streams text forever while completing nothing
satisfies both and burns the full wall-clock cap plus the engine's poll budget behind it. A third
watchdog now fails a run that keeps talking without completing a tool call, under its own
`no-tool-progress` failure cause rather than reusing `inactivity-timeout`: the two need different
fixes, and "the container went quiet" is the wrong thing to tell someone whose model was mid-
monologue.

The wrong-kill risk this creates is what shaped it. The window is armed ONLY while the agent phase
runs, so clone, dependency install and push (activity-silent by nature, and bounded by their own
per-command timeouts) sit outside it by construction. It is derived from `JOB_MAX_DURATION_MS`
rather than fixed, so shortening a deployment's jobs shortens it too instead of silently disabling
it, and it is clamped to at least `JOB_INACTIVITY_MS` so it can never pre-empt the gone-quiet
diagnostic. That ordering is also why it needs no "but was the run chatty?" test: a genuinely
silent run always trips inactivity first. `JOB_TOOL_SILENCE_MS` overrides it; `0` disables it.

**The bootstrap push phase could not be interrupted.** `reinitAndPush` was the one git helper that
never threaded the job's abort signal, so an abort raised during it kept working through six
commands bounded only by their own timeouts, well past the max-duration kill that had already
fired.

Two things reviewers should look at. The new failure cause is additive across a hand-kept boundary
(the image can carry no workspace dependency, so the harness union and the kernel one are copies);
a conformity test now pins that every cause this image stamps is one kernel classifies, which is
the direction that fails silently, degrading a watchdog kill into a generic agent error. And
`RunnerLimits` gained a required field rather than an optional one, so every construction site had
to declare its window, which is the existing convention there for exactly this reason.

Ships with runner image 1.97.0.
