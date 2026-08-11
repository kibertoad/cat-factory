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
`noHiddenInput()`, naming that cause and the way out FOR THE PLATFORM it is thrown on, since the
second refusal is just as reachable on POSIX (a `docker exec` with no `-t`, a detached `screen`) as
it is from the MSYS/mintty window `winpty` fixes. Named for Windows alone it would have been the
same defect one platform over: a confident refusal with the wrong cause. `cmd.exe` is deliberately
not among the terminals offered, though it implements console modes: this suite prints its Windows
commands in PowerShell's dialect, so sending an operator there fixes one prompt and breaks every
command printed afterwards. Raw mode is still entered by `openTerminal` rather than by the read,
because being readable without echo is what that function promises and opening the device does not
establish it.

**And the verdict on that switch is the stream's own `isRaw`, not "the call did not throw".**
`setRawMode` reports a failure by EMITTING `error`, which reaches a caller as a throw only because an
unhandled `error` is what Node turns into one. On the `process.stdin` fallback path, where something
else in the process is usually already listening, the identical failure arrives as a quiet return
with echo still on, and a try/catch reads it as success: the prompt then takes the operator's
password into the scrollback, which is the one thing this file exists to prevent, failing silently
rather than refusing.

Releasing them is `releaseTerminal`, and it encodes the one rule that cleanup has to get right: the
descriptor a `ReadStream` is CONSTRUCTED with belongs to the stream, so `input.destroy()` is that
descriptor's close and a `closeSync(fd)` beside it throws `EBADF` out of the cleanup. That cost both
paths through this prompt. On the refusal path it came out of the `catch` and replaced the message
naming the password and both ways out; on the ordinary path it came out of the `data` handler at the
instant a typed password was accepted, leaving the promise unsettled and hanging a prompt that had
already succeeded. Echo is now restored by the same function, guarded on the stream's own `isRaw`, so
a prompt that could not be WRITTEN no longer returns the operator to a shell that echoes nothing. The
end of the read obeys the same rule for the same reason: the promise settles BEFORE the trailing
newline is written, because that write runs inside the `data` handler and a failing one would
otherwise escape through `emit` and strand the promise, which is the identical hang by another route.

The README now states the invocation together with what makes it work under vitest at all, which is
the part that reads like it cannot: a worker is forked with piped stdio, so the prompt goes to the
console devices directly rather than through the stdio the reporter owns.

**And it is asked ONCE per pass, before the first spec, rather than once per spec file.** Vitest
isolates every test file in its own module graph and its own worker process, so the holder in
`fixtures.ts` cannot outlive the file that built it: asked lazily, a pass that starts and answers runs
across four specs is asked four times, and each of those prompts is written while the reporter is
redrawing test lines over it, which is how an operator ends up unsure whether their password was even
accepted. `acceptance/globalSetup.ts` asks in the MAIN process before any worker exists and before a
test line is printed, and hands the value to each worker through vitest's `provide`/`inject`, which is
the RPC channel rather than a file.

It asks only when it can tell one will be needed: the pinned preset's base model reporting
`personalSubscription`, which is `personalSubscription` alone and never `available`, since a selectable
personal-subscription model is exactly the case whose dispatch still answers `428`. A provider-key
workspace is asked nothing. A catalog it could not read says so and leaves the ask at the first
dispatch, so an unreachable deployment loses nothing and the preflight keeps ownership of diagnosing
it.

**That hook can only ever DELAY the ask, never end the pass.** It runs before the first prerequisite
is evaluated and before a journal line exists, so anything it throws is the operator's whole output:
no "your key is bound to another workspace", no "the pinned preset's model is unwired", no ledger, no
journal, and no chance to fix the thing that was actually wrong. So a terminal it cannot ask on is
PRINTED and continued from, and the dispatch that needs a password is what stops the pass, with
everything the preflight found already on screen. The one refusal that does end it there is a person
pressing Ctrl-C, which is a decision rather than a limit and would otherwise start an afternoon-long
run that spends real money. All of that lives in `src/personalPasswordAsk.ts` with the hook reduced
to wiring, because a degradation nothing tests is a degradation that quietly becomes an abort.

Two consequences worth knowing. The password now sits in the main process's memory as well as each
worker's, which is the cost of asking once; no copy is written down, which is the property the design
protects. And `test.env` is not applied in the main process, so the `.env` reader moved to
`src/envFile.ts` and is now read by the vitest config and the hook alike rather than existing twice.

**Every command this suite prints with a variable in it is now rendered for the shell that will
receive it.** The same session found the second half of the same problem: `VAR=value command` and
`export VAR=value` are POSIX syntax, and between them they were hard-coded into the banner every spec
file opens with, both prerequisite remedies that offer a resume, the line the status report ends with,
the per-person prefix remedy, and the three remedies whose whole fix is one value (a workspace id, a
repository owner, an ingress template). The banner is the most printed of them: it is where an
operator whose pass died in spec 03 recovers the run id, and it has no other source. PowerShell has no inline environment prefix and no `export` at all, so it reads each as the
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
`cmd.exe` reads as PowerShell, and that is a stated LIMIT rather than a decision: nothing in the
environment separates the two (`ComSpec` is in both, and cmd's own `PROMPT` is inherited by a
PowerShell started from a cmd window), while guessing the other way would hand `&&` to Windows
PowerShell 5.1, which cannot parse it at all. What follows from the limit is that nothing may send an
operator to cmd.exe, which is why the echo refusal above no longer does.

**The PowerShell resume clears the variable it set.** `$env:` is the process environment: no block,
function or child scope narrows it, so the form this suite printed set `ACCEPTANCE_RUN_ID` for the
rest of that window and every later `run acceptance` in it silently resumed the finished pass. That
is the exact cost `resumeInvocation` refuses to print a `.env` line for, and the POSIX prefix it
replaces does not have it, so one "resume" meant two different things by dialect. It now renders
`try { … } finally { Remove-Item Env:… }`: `finally` rather than a trailing `;`, because an
interrupted pass is when a resume is likeliest to be wanted next.

Each renderer is asserted for both dialects with an injected flavour rather than against
`process.platform`, so the PowerShell form is covered by the Linux CI lane that would otherwise never
execute it. The call-site tests compare against the renderer instead of restating a spelling, so
shell knowledge lives in one place.

The README documents both forms plus the `.env` line, which is the one form needing no dialect, and
states what each costs: a line in the file persists until it is removed, and a hand-typed `$env:`
without the clear persists for the session, so either one silently resumes a pass you meant to leave
behind.

Still POSIX-only, named as the exception in the README rather than left to be discovered: the `curl`
remedies interpolate `$CAT_FACTORY_API_KEY`, which PowerShell expands as one of its own variables and
sends as an empty bearer token. That is a sweep over every read and write command in
`prerequisites.ts` and wants its own change.
