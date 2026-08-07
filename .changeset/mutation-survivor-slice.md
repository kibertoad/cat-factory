---
---

Close the mutation-testing findings the nightly had been reporting in `@cat-factory/gates`, and give kernel's registry seams their first tests

Test-only: no source in a versioned package changed, so nothing here needs a version bump.

Two dispositions, matching the two columns the mutation report separates. The gates work is the
"add the missing assertion" kind, taken from the surviving mutants an actual run reported rather
than from a reading of the code. The kernel work is the "which module gets its FIRST test" kind,
which is what the gap between the total and covered-code scores is made of.

The gates survivors were not all cosmetic. The one worth naming is `applyGateProviders`: its
presence check is per key, and only the `ciStatus` branch was pinned, so the other five were free
to drop theirs. That failure is not a missing wiring but a CLEARED one, because an absent key would
reach `wire(token, undefined)`, which DELETES the entry: a single-key override from a test or an
embedder would silently unwire the five providers the facade's config had already supplied and turn
those gates into pass-throughs. The other three are the human-review gate's unbounded attempt budget
(an absent budget is not the same statement as an unbounded one; the engine reads it as "declared
nothing" and falls back to the preset's CI budget, which auto-fails a run a reviewer had not got to
yet), the prior-output that carries the reviewer's words across to the fixer, and the two ordering
scans in `review.logic` (the merged conversation the fixer reads, and the newest-feedback scan the
grace window measures from, which was only ever exercised with one entry per list).

Two of the new guards state what they check instead of reading it back off the code, which is the
difference between a guard and a tautology. The helper-briefing guard classifies every built-in
gate as briefing its helper through the gathered-evidence seam, the precheck-summary seam, or
neither (only `conflicts`, whose resolver opens on the merge markers themselves), so dropping a
declaration fails the gate's row rather than quietly removing it from a filtered set, and a new
gate has to decide before it passes. The outstanding-conversation cursor guard now seeds both the
plain comments and the review summaries with a bot, an at-cursor and an after-cursor entry: with a
bot alone on the summaries leg, a cursor applied to the comments only stays green while the
review-fixer is re-dispatched forever on an already-addressed `CHANGES_REQUESTED` summary.

Left alone deliberately: the four `reason` string literals on the human-review verdicts, and the
`>=`-for-`>` mutants in the newest-feedback scan. The first are operator-facing prose, and pinning
them verbatim is the re-pinned-unread test the conventions warn about. The second are equivalent
mutants: on an equal value both comparisons assign the same number, so no test can distinguish them.
A `Stryker disable` for either would hide a survivor rather than explain one.

The kernel half gives a first test to thirteen `domain/`+`shared/` modules that had none, chosen as
one coherent set: the registry seams a deployment extends the platform through (pipeline, provider,
VCS, judge, step-resolver, task-type, prompt-fragment), the pure resolution helpers around them
(cache policy, writeback override, workspace metadata, initiative kinds, process exit, source
registry), plus `catalog`'s seeding logic and `registerServiceForFrame`. Their shared shape is that
a break is silent rather than loud: a registry that accumulates where it should replace, a stub
context reading a private registry instead of the one it was handed, or a frame's board position
written onto the account-owned service instead of onto the per-board mount.

The scope excludes what the report says is not worth pinning: `workspace-cascade`'s table and
`doc-interview-logic`'s single constant are top-level constants, so `ignoreStatic` leaves them
unmeasured either way, and asserting shipped data line by line buys nothing.

One finding is about the instrument rather than the code, and it is recorded in the doc: a value
computed in a `describe` BODY is read from unmutated source, because mutants activate per test at
run time and a describe body runs at collection time. That hides precisely the derive-from-the-
source drift guards the testing conventions ask for, and `gates`' human-wait parity guard was one:
the whole `pollExhaustion: 'rearm'` declaration it exists to protect could be emptied with all four
of its cases green. It builds its snapshot inside the tests now.

Measured, one package at a time on an idle machine, with both floors raised by the same rule they
were set with (truncated total, less two points): gates 85.25% / 89.37% → 88.17% / 91.99% over the
same 651 mutants, floor 83 → 86. Kernel 78.95% / 83.63% → 81.78% / 84.51% over 6,152, floor 76 → 79,
measured as a pair of runs on ONE scope (the new test files moved aside and back) because main
gained 37 mutants since the row this table previously carried. 145 mutants left `NoCoverage` and
174 more were killed; the extra 29 landed in modules that already had tests, which is what
exercising a seam end to end reaches that its own file's suite drives past.
