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

Behaviour change to review: `WebSearch`/`WebFetch` are declared only when the backend says the
deployment serves web research, so a deployment with no search provider wired no longer gets them
from the CLI's default set.
