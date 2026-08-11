---
'@cat-factory/acceptance': patch
---

Ask for the personal password on Windows at all, and refuse by the RIGHT cause when it cannot.

A pass pinned to an individual-usage model stops at its first dispatch to ask for the operator's
personal password. On Windows it never asked: it failed with `Error: setRawMode EPERM`, errno -4048,
naming neither the password it wanted nor anything to do about it.

The cause is the OPEN, not the console. Turning echo off is `SetConsoleMode`, which WRITES to the
console input buffer, so the handle needs `GENERIC_WRITE`; `\\.\CONIN$` was opened `r`, which reads
perfectly well and then refuses raw mode with `EPERM` on a machine with a console right there.
`consoleDevice()` now opens it `r+` and the prompt appears. Verified inside a vitest forked worker,
the environment that makes this prompt awkward in the first place: `r` throws `EPERM`, `r+` enters
raw mode and writes to `CONOUT$`.

That also corrects what this file believed. The `EPERM` was read as evidence that a console-less
process opens `CONIN$` happily, so the missing-terminal refusal was moved onto the raw-mode switch.
A console-less process cannot open `CONIN$` at all (`EBADF`, the same fact as POSIX's `ENXIO` for
`/dev/tty`), so that refusal belongs on the OPEN, where it started, and moving it there produced a
confident refusal with the wrong cause: an operator in a JetBrains terminal was told to "run the
suite from an interactive shell", which is what they were doing.

So there are two refusals now, because they need two different actions. No device to reach:
`noTerminal()`, unchanged. A device that reaches a terminal which will not stop echoing:
`noHiddenInput()`, naming that cause and the terminals that do implement console modes, with
`winpty` for the MSYS/mintty window where this is expected. Raw mode is still entered by
`openTerminal` rather than by the read, because being readable without echo is what that function
promises and opening the device does not establish it.

Releasing them is `releaseTerminal`, and it encodes the one rule that cleanup has to get right: the
descriptor a `ReadStream` is CONSTRUCTED with belongs to the stream, so `input.destroy()` is that
descriptor's close and a `closeSync(fd)` beside it throws `EBADF` out of the cleanup. That cost both
paths through this prompt. On the refusal path it came out of the `catch` and replaced the message
naming the password and both ways out; on the ordinary path it came out of the `data` handler at the
instant a typed password was accepted, leaving the promise unsettled and hanging a prompt that had
already succeeded. Echo is now restored by the same function, guarded on the stream's own `isRaw`, so
a prompt that could not be WRITTEN no longer returns the operator to a shell that echoes nothing.

The README now states the invocation together with what makes it work under vitest at all, which is
the part that reads like it cannot: a worker is forked with piped stdio, so the prompt goes to the
console devices directly rather than through the stdio the reporter owns.

**Every command this suite prints with a variable in it is now rendered for the shell that will
receive it.** The same session found the second half of the same problem: `VAR=value command` and
`export VAR=value` are POSIX syntax, and between them they were hard-coded into both prerequisite
remedies that offer a resume, the line the status report ends with, the per-person prefix remedy, and
the three remedies whose whole fix is one value (a workspace id, a repository owner, an ingress
template). PowerShell has no inline environment prefix and no `export` at all, so it reads each as the
command NAME and answers `CommandNotFoundException`. On the Windows machine this suite is documented
to run a local deployment on, every one of those pasted into a failure. A remedy that does not parse
is worse than no remedy, because it is offered as the thing to run, which is the rule `shellQuoted`
already existed for.

`operatorText.ts` (which owns how a value becomes text an operator pastes) now decides every dialect
in ONE table, and the renderers above it say what they need rather than which shell is in play:
`resumeInvocation` for a value scoped to one command, `envAssignment` for one that is kept, and
`perPersonPrefixInvocation` for the one whose value is a live username substitution. That last one is
also the one place a shell still expands what came from the environment, so the literal half is
escaped per dialect: `ACCEPTANCE_NAME_PREFIX` is read verbatim from an operator's `.env`, and
unescaped, a prefix holding `$(…)` was not a broken command but a command that RAN something else on
paste.

**The dialect follows the SHELL, not the platform.** Git Bash and MSYS are ordinary places to drive
this suite from on Windows, and there the PowerShell form is worse than the POSIX one it would
replace: bash expands `$env:ACCEPTANCE_RUN_ID` to nothing, answers `=: command not found`, and never
reaches the command, so a printed RESUME silently starts a second pass. `SHELL`/`MSYSTEM` decide;
`PSModulePath` deliberately does not, since Windows sets it machine-wide and Git Bash inherits it.

Each renderer is asserted for both dialects with an injected flavour rather than against
`process.platform`, so the PowerShell form is covered by the Linux CI lane that would otherwise never
execute it. The call-site tests compare against the renderer instead of restating a spelling, so
shell knowledge lives in one place.

The README documents both forms plus the `.env` line, which is the one form needing no dialect, and
states what each costs: `$env:` persists for the whole session and a line in the file persists until
removed, so either one silently resumes a pass you meant to leave behind.

Still POSIX-only, named as the exception in the README rather than left to be discovered: the `curl`
remedies interpolate `$CAT_FACTORY_API_KEY`, which PowerShell expands as one of its own variables and
sends as an empty bearer token. That is a sweep over every read and write command in
`prerequisites.ts` and wants its own change.
