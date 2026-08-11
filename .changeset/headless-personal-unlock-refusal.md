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

**Every command this suite prints is now rendered for the shell that will receive it.** The same
session found the second half of the same problem: `VAR=value command` is POSIX syntax, and it was
hard-coded into both prerequisite remedies that offer a resume, the line the status report ends with,
and the per-person prefix remedy. PowerShell has no inline environment prefix, so it reads the
assignment as the command NAME and answers `CommandNotFoundException`. On the Windows machine this
suite is documented to run a local deployment on, every one of those pasted into a failure. A remedy
that does not parse is worse than no remedy, because it is offered as the thing to run, which is the
rule `shellQuoted` already existed for.

`resumeInvocation` and `perPersonPrefixInvocation` (in `operatorText.ts`, which owns how a value
becomes text an operator pastes) render both dialects, and each is asserted for both platforms with
an injected `platform` rather than against `process.platform`, so the Windows form is covered by the
Linux CI lane that would otherwise never execute it. The call-site tests now compare against the
renderer instead of restating a spelling, so shell knowledge lives in one place.

The README documents both forms plus the `.env` line, which is the one form needing no dialect, and
states what each costs: `$env:` persists for the whole session and a line in the file persists until
removed, so either one silently resumes a pass you meant to leave behind.
