---
'@cat-factory/executor-harness': minor
---

Declare the claude-code CLI's built-in tool set with `--tools` instead of taking its headless
default. The default carried no `Grep`, no `Glob` and no plan tools (so every search went through
`Bash` and counted against the progress guard's no-edit budget, and `step.progress` had no signal
to lift), plus a dozen tools an ephemeral container can act on none of.

The same declared list now rides the `--allowedTools` re-grant, which is ADDITIVE rather than
inert: a name in it unlocks a tool. Threading one value removes the drift where a run's capability
depended on whether an unrelated tool server happened to narrow itself.

The declared set is measured against the DEFAULT it replaces, not only against what is wanted:
anything the default carried that a container can still act on is asked for by name, or the
declaration is itself a capability loss. A retired name is kept beside its successor because
`--tools` treats one as an ALIAS of the other (`BashOutput` grants `TaskOutput`; `KillBash` and
`KillShell` both grant `TaskStop`), which is how one pinned image faces several CLI versions.

`WebSearch`/`WebFetch` stay unconditional. They are served by the vendor the leased subscription
already pays rather than by this deployment's web-search proxy, so the proxy's availability, which
is what the job's `webSearch` flag states, does not decide whether they work; gating them on it
would have withheld a working capability from every deployment with no search provider wired.

Fixed alongside: the conflict-resolver and bootstrap flows forwarded neither web-research field to
the agent, so a deployment that serves web research had two flows whose agents were never given
it. Those fields now travel with the other per-job capabilities in `agentCapabilities`, and a
structural guard fails a mode that forwards none.
