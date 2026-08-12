---
'@cat-factory/acceptance': patch
---

Close the gaps review found in the standalone acceptance runner.

`status` now reads the package `.env` the way every other command does, so the `watch:` and `report:`
commands the pass prints resolve to the same state directory the pass wrote to; read off the shell
alone it answered "No acceptance pass found" about a pass that was running right then. A base URL is
scrubbed at the three sites that print one, including the preflight step name the journal persists on
failure, since userinfo in a URL is legal and that file is meant to be shareable. The pass has an
error boundary: a throw from a scenario factory or from the closing report is now named as a failure
of the SUITE, with the run id, both file paths and the resume command, instead of an unhandled
rejection that exits 1 with none of them.

The preflight report's evaluation is handed to the gate that runs seconds behind it, so a fresh pass
no longer evaluates all fourteen prerequisites twice; every later gate is unchanged and still fully
re-evaluated. `recordsFacts` classifies each ledger slot rather than scanning the whole object, so a
future non-record field on the ledger cannot silently make every pass claim it created something,
and `thrownLocation` cuts the message off a stack by its content instead of scanning it for `at `,
which was lifting indented lines of this suite's own multi-line refusals out as if they were frames.

The scenario order has a test again (it lost one with `src/specOrder.ts`), pinned as a relation
between each id's numeric prefix and its position so adding a scenario in the right place passes.
Also: the package root is resolved in one place rather than four, the driver's gate and failure seams
drop a scenario argument nothing could implement, and the up-front password ask uses the pass's own
SDK client instead of building a second one.
