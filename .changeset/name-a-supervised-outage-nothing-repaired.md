---
'@cat-factory/cli': patch
---

Name a supervised outage the supervisor did not cause, and timestamp every `[supervise]` line.

`cat-factory supervise` reported a self-healed outage as `✔ serving again (after 2 failed
probe(s))` — a tick reading as a success, on a line with no clock. But reaching that state means
something restarted the stack **underneath** the supervisor: a repair of ours resets the counters
and re-bases the grace window, so the first serving tick after one reports plain `serving`. The
only way to log `recovered` is for the stack to have gone down and come back with no repair in
between.

That is the shape of a `node --watch` file-change storm. The watcher cycles the server several
times in a row, the port is unbound for a few seconds, and any client mid-request dies with
`ECONNREFUSED` — while nothing crashes, every process involved stays alive, and `/health` answers
200 again by the time anyone looks. The stack is genuinely healthy afterwards, so the two
probe-failure lines left behind read as noise, and the outage is indistinguishable from a flaky
probe.

The recovery is now a **warning** that says what happened, how long it lasted, and that the
supervisor did not do it, with the likely cause spelled out on the first occurrence only (the
warn-once rule the dependency ladder already follows):

```text
[supervise 11:50:53] • health probe failed (1/3)
[supervise 11:51:03] ⚠ serving again after 19.3s down since the first failed probe
                       (2 failed probe(s)) — unexplained outage #1, no repair of ours caused it
  ↳ something restarted the stack underneath the supervisor. On a `node --watch` deployment this is
    usually a file-change storm: … Check the server log for repeated "Restarting" lines with no
    error between them.
```

Downtime is measured from the first **counted** failed probe, not from any non-serving observation,
so a cold boot inside the grace window is never reported as an outage — the port is legitimately
unbound while the workspace builds and migrations run. The consequence is that the window
under-reports by up to one `--poll` interval, which is why the line says "since the first failed
probe" rather than claiming a precision the probe interval cannot deliver.

Every `[supervise]` line now carries local `HH:MM:SS`. These lines are read interleaved with the
supervised server's own structured logs and are usually the only record that a transient outage
happened at all; without a clock on them, placing the outage in time meant interpolating from
whichever neighbouring line happened to carry one.

`SuperviseState` gains `notServingSince`, the `recovered` action gains `downMs`, and
`SupervisorOutcome` gains `unexplainedOutages` — counted separately from `repairs` because the two
have opposite meanings to a reader: a repair is the supervisor working, while an unexplained outage
is the supervised stack cycling on its own. A run that ends with several of them looks healthy by
every other measure.
