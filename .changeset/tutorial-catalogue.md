---
'@cat-factory/app': minor
---

Add a tutorial catalogue: every guided walkthrough the deployment ships, startable, resumable or
repeatable at any time from the sidebar's new Help section, the command palette, or the launch
prompt's footer.

A tour's preconditions are now DECLARED (`TutorialRequirement`) instead of an anonymous
`when(gates)` predicate, so a tour this board cannot run yet is listed with what would unlock it
rather than silently omitted — and "requirements unmet" is kept distinct from "no step applies
here". Tour resolution consequently moved out of `navSlotFilter` (a slot filter can only drop) into
the pure `resolveTourCatalogue`, read once in `useTutorialTours`; the set of tours the launch
prompt and the overlay see is unchanged.

`Reset progress` is offered whenever anything it would clear is set — including a launch offer that
was merely answered — so the user who declined once and took no tour can still get the first-launch
experience back. The coach marks stand down while the prompt or the catalogue is open, since the
overlay deliberately renders above the app's modals and no tour step points into the tutorial's own
windows.
