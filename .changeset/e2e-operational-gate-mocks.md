---
'@cat-factory/conformance': patch
---

test(conformance): reusable fake gate providers + an on-call assessment channel on the fake agent

Extract the inline `ci` / `doc-quality` fake gate providers into a shared
`fakeGateProviders` module (`makeFakeCi` / `makeFakeMergeability` / `makeFakeReleaseHealth` /
`makeFakeDocQuality`), exported from the package index so both the cross-runtime conformance
suite and the e2e test backend reuse one implementation instead of copy-pasting per-probe
verdict queues. `FakeAgentExecutor` gains an `onCallAssessment` option and an `on-call` branch
so the post-release-health gate's INVESTIGATE-don't-fix helper returns a structured assessment
(the generic prose fall-through left it null). These back the new operational-gate + agent-loop
e2e specs (CI→ci-fixer, conflicts→conflict-resolver, post-release-health→on-call, Tester→Fixer,
companion rework, follow-up gate).
