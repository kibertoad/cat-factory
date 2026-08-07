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
buffer a runaway record, and the close path folds each record as it streams instead of re-parsing
anything.

Folding rather than retaining is what closes the memory half: an unbounded array of parsed records
is not a smaller copy of the run than its text, it is a larger one, and a container that exhausts
its heap stops answering polls the same way a blocked loop does. The reducer keeps only what the
close-of-run answers actually read, so a run costs the largest single record rather than all of
them. Framing likewise scans each incoming chunk rather than the accumulated buffer, because any
search over that buffer flattens it: scanning it per chunk cost about six seconds of solid
blocking on one 32 MB record, which would have bounded the memory and handed back the stall.

A dropped oversized record is dropped whole rather than truncated, and counted: half a JSON
document is not a record, and handing the parser one would report the bound firing as corrupt
model output. The cap is on the record, not on the leftover buffer, so it cannot depend on how the
OS happened to split the reads. It sits far above the largest legitimate record, and that record
is the terminal transcript, which is also the one deciding whether a clean exit actually failed —
so a run whose terminal record was dropped is now refused rather than certified. Reporting a
hard-failed run as a success is precisely what that check exists to prevent, and the subscription
stream, which counted its drops and said nothing, now reports them too.

**A chatty model trips no guard at all.** The inactivity watchdog resets on any output, and the
no-progress guard counts tool calls, so a model that streams text forever while completing nothing
satisfies both and burns the full wall-clock cap plus the engine's poll budget behind it. A third
watchdog now fails a run that keeps talking without completing a tool call, under its own
`no-tool-progress` failure cause rather than reusing `inactivity-timeout`: the two need different
fixes, and "the container went quiet" is the wrong thing to tell someone whose model was mid-
monologue.

The wrong-kill risk this creates is what shaped it. The window is opened by the agent stream that
can reset it, not by the job's coarse phase label: only the runner knows whether its CLI reports
completed tool calls, and the `agent` label is marked by several call sites for work that reports
none at all, so arming on it would have covered mostly things that could only let the window
expire. Work with no tool loop opens no window and says why. The window is derived from
`JOB_MAX_DURATION_MS` rather than fixed, so shortening a deployment's jobs shortens it too instead
of silently disabling it. And it fires only when output arrived during the window that elapsed,
which is what keeps a hang with the inactivity watchdog whose diagnostic an operator can act on:
the two anchor on different events, so no relation between their lengths can order them.
`JOB_TOOL_SILENCE_MS` overrides the window; `0` disables it.

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
