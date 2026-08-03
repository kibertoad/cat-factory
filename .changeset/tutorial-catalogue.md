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
