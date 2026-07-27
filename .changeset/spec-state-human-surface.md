---
'@cat-factory/app': minor
---

Surface the in-repo spec's implementation-state axis to humans (service-acceptance-criteria,
slice 4).

`requirementItem.state` (`aspirational` = agreed, `established` = a tester observed it hold)
already reached every agent-facing consumer — the rendered group markdown, the `@aspirational`
Gherkin tags, the build/test prompt rules, the promotion post-op — and a PR reviewer through the
verification report's requirement → evidence section. The platform's own reader saw none of it:
the Requirements window listed each requirement's priority and kind and could not say which of
them the service is actually known to honour.

- `ServiceSpecWindow.vue` badges every requirement with its implementation state, adds a
  per-group rollup plus a three-way state filter (all / established / aspirational), and shows a
  service-wide rollup on the overview pane. The counting and filtering live in the pure
  `ServiceSpecWindow.logic.ts`; anything that is not literally `established` reads as
  `aspirational`, so an unrecognised value never claims the service honours a behaviour. The
  filter is sticky across groups, so a group it empties says so and offers a reset.
- `StepTestReport.vue` renders the tester's per-requirement verdicts (`met` / `not met` /
  `not checked`) — the in-app twin of the PR report's section, readable during the run rather
  than only once the report publishes. An unrecognised status renders the raw code in its own
  colour rather than borrowing `not_covered`'s, so version skew can never read as "not checked".

Frontend-only: `ServiceSpecView` already carries `state` and the verdicts already ride
`step.testReport`, so no endpoint, wire shape or backend behaviour changes.
