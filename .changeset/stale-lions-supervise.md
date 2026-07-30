---
'@cat-factory/local-server': minor
'@cat-factory/server': minor
---

Supervise an inline host-CLI run by how long it is STUCK, not by how long it works.

`spawnCliExec` armed one 300s timer at spawn and never touched it again, so the budget bounded the
whole run: an inline step was killed for being SLOW rather than for being stuck, with nothing a
deployment could set to say otherwise. The observed failure is a `doc-researcher` on the ambient
`claude` CLI killed at exactly 5 minutes having made 53 model calls, burned 2.9M tokens and run 24
tool calls — legitimate work, mid-turn — and every retry died the same way, so the step could never
complete. That also made it permanently unaccounted for: usage reaches `token_usage` from a call
that COMPLETED, so a step that dies on every attempt records nothing however much it spent, which
is what "the run shows zero model calls" actually meant.

Two budgets now, because "hung" and "long" are different failures with opposite fixes:

- an **idle** window (`LOCAL_INLINE_CLI_IDLE_TIMEOUT_MS`, default 300000) re-armed by every chunk on
  either stream, so it measures the gap between bytes. `stream-json` narrates a healthy `claude`
  continuously, so silence this long is a real symptom while elapsed time never was.
- an absolute **ceiling** (`LOCAL_INLINE_CLI_MAX_TIMEOUT_MS`, default 3600000) for the run that
  narrates forever and therefore never looks idle — the one case an idle window cannot bound.

Both still reject as a `timeout` (unchanged for callers), but they say different things: the idle
kill names the silence it overran, the ceiling kill names the ceiling and the variable that raises
it. The idle message drops the redundant silence clause it would otherwise restate. The FIRST kill
wins: every trigger stays armed until the child closes, so an abort landing inside the SIGKILL
grace period used to overwrite the reason and surface a supervised kill as a user cancellation.

New in `@cat-factory/server`: `parseTimerEnvMs`, the validator for an env var that becomes a
`setTimeout` delay, beside the `parseNumericEnv` it is deliberately stricter than. A plain numeric
knob is right to accept `0` / `-1` / `1.5`; a timer budget is not, and neither is a value above
`MAX_TIMER_DELAY_MS` (2147483647) — Node truncates a larger delay to **1ms** rather than saturating,
so the number an operator types meaning "effectively no ceiling" is exactly the one that would kill
every supervised run within milliseconds, while reporting the enormous ceiling it claims to have
hit. Every unusable spelling now warns and defers to the built-in default.

The incoherent-pair warning (a ceiling below the idle window makes the idle watchdog unreachable, so
a stuck CLI is reported as a slow one and the operator raises the wrong number) now compares the
EFFECTIVE budgets rather than only the explicitly-set ones — lowering just the ceiling is the likelier
single-knob edit, and gating on both being present let exactly that case through in silence.
