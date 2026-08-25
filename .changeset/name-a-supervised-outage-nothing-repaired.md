---
'@cat-factory/cli': patch
---

Name a supervised outage the supervisor did not cause, and timestamp every `[supervise]` line.

`cat-factory supervise` reported a self-healed outage as `✔ serving again (after 2 failed
probe(s))` — a tick reading as a success, on a line with no clock. But if the stack had already
been answering, reaching that state means something restarted it **underneath** the supervisor: a
repair of ours resets the counters, so the only way there is for the stack to have gone down and
come back with nothing of ours in between.

That is the shape of a `node --watch` file-change storm. The watcher cycles the server several
times in a row, the port is unbound for a few seconds, and any client mid-request dies with
`ECONNREFUSED` — while nothing crashes, every process involved stays alive, and `/health` answers
200 again by the time anyone looks. The stack is genuinely healthy afterwards, so the two
probe-failure lines left behind read as noise, and the outage is indistinguishable from a flaky
probe.

The recovery is now a **warning** that says what happened, how long it lasted, and that the
supervisor did not do it, with the likely cause spelled out on the first occurrence only (the
warn-once rule the dependency ladder already follows), and the running total repeated in a summary
line at shutdown — the only place those counts stay legible on a supervisor left up for days:

```text
[supervise 11:50:53] • health probe failed (1/3)
[supervise 11:51:03] ⚠ serving again after 19.3s down since the first failed probe, give or
                       take the 10s poll interval (2 failed probe(s)) —
                       unexplained outage #1, no repair of ours caused it
  ↳ something restarted the stack underneath the supervisor. On a `node --watch` deployment this is
    usually a file-change storm: … Check the server log for repeated "Restarting" lines with no
    error between them.
[supervise 12:31:07] stopped after 241 probe(s): 0 repair(s), 1 unexplained outage(s)
```

**Only a stack that had already answered can have been taken down by something else.** A recovery
where the child has never served since it was started is our own boot binding late, and is reported
as a slow start naming `--boot-grace` instead. Without that split, a cold boot slower than the grace
window — and, worse, every repair whose restarted stack is, since a repair re-bases that window —
recovers as `no repair of ours caused it`, blaming an invisible third party for a gap the supervisor
had just created itself.

Downtime is measured from the first **counted** failed probe, so a cold boot inside the grace window
is never reported at all: the port is legitimately unbound while the workspace builds and migrations
run. Both ends of the resulting window are quantized to the poll interval and the errors point in
opposite directions, so the figure is the truth ± one poll rather than a floor — at the default 10s
poll a 100ms blip and a 10s outage render identically. Every rendering therefore names the interval
it was measured against.

Every `[supervise]` line now carries local `HH:MM:SS`. These lines are read interleaved with the
supervised server's own structured logs and are usually the only record that a transient outage
happened at all; without a clock on them, placing the outage in time meant interpolating from
whichever neighbouring line happened to carry one.

`SuperviseState` gains `notServingSince` and `servedSinceStart`, the `recovered` action gains
`downMs` and a `cause` the caller must branch on, and `SupervisorOutcome` gains
`unexplainedOutages` — counted separately from `repairs` because the two have opposite meanings to
a reader: a repair is the supervisor working, while an unexplained outage is the supervised stack
cycling on its own. A run that ends with several of them looks healthy by every other measure.
