---
'@cat-factory/acceptance': patch
---

Say that a pass has no terminal to ask the personal password on, instead of `setRawMode EPERM`.

A pass pinned to an individual-usage model stops at its first dispatch to ask for the operator's
personal password, and `openTerminal` promises in as many words to refuse "when there is no terminal
to reach at all (CI, a daemon), naming what to do instead". It did not. Windows opens `\\.\CONIN$`
quite happily in a process with NO CONSOLE attached, so the missing-terminal guard passed, the
`process.stdin.isTTY` fallback was never consulted, and the refusal landed one line later on the
raw-mode switch as `Error: setRawMode EPERM`, errno -4048. That names neither the password it was
asking for nor either way out, in precisely the situation where a person has to change how they
invoked the pass.

Raw mode is now entered by `openTerminal` rather than by the read, because being readable without
echo is what that function promises and opening the device does not establish it. A failure there
becomes the same `noTerminal()` refusal, with the original error kept as its `cause` (an `EPERM` is
the interesting half only when the failure is something else) and the console handles released so a
refused prompt does not leak one.

The trigger is not exotic: CI, a daemon, `nohup`, and an agent's detached background shell all reach
it, and it was found by running the suite from one. Nothing about the interactive path changes, so
this is a message, not a behaviour change. The README now states the invocation together with what
makes it work under vitest at all, which is the part that reads like it cannot: a worker is forked
with piped stdio, so the prompt goes to the console devices directly rather than through the stdio
the reporter owns.
