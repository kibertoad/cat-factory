---
---

Cut `CLAUDE.md` roughly in half, by challenging whether each entry earns its place in a file loaded
into every session rather than by rewording what was there.

Three things came out entirely, because they described a feature rather than constraining a change
to one, and their content already lives in `backend/docs/`: the reports endpoint
(`backend/docs/reports.md`), individual-usage subscriptions
(`backend/docs/individual-subscription-usage.md`), and the unified `agent_runs` failure/retry surface
(ADR 0026/0027). The package-by-package layout list also went: the root README carries that table and
CI already guards its completeness, so restating it here was the exact "higher-level doc restates the
deeper doc" failure the file's own staleness rule forbids.

The flow narratives became an INDEX. Each entry now states what the flow is and the trap a change
would hit, then links its ADR or initiative doc as the authority — which is what those docs are for,
and most of the removed prose was a second copy of them. The rules those flows had established in
passing were the real loss risk, so they are hoisted into four state-once sections instead of living
inside whichever flow happened to discover them: concurrency/idempotency/replay (the rev-guard, the
unique index over delete-then-insert, the atomic claim before an external side effect, first-write-
wins on a chain-derived row), untrusted text crossing a rendered surface (`hostMarkdown`,
`redactSecrets` at compose time, pathspec magic, `fencedOutput`), degrade loudly (absent ≠ zero,
distinguish the causes, the model judges and the platform computes), and harness rules (per-job
state, the silent-phase heartbeat, image-bump coupling). Several of those had been stated three or
four times across different flows.

Section headings that other docs and the README link to by name are unchanged, so inbound
"CLAUDE.md → section" references still land: Gates vs agents, Telemetry & agent-context
observability, Internationalization, Releases & changesets, Board / service / repo-linkage model,
Keep the runtimes symmetric, Real-time store coherence, Migration safety, Requirements review,
Service blueprints, Repo bootstrap.

What to look out for in review: the judgement calls about what stopped earning its keep. Every
prescriptive rule was kept, and the deletions were checked to have a home elsewhere before removal,
but the trade is real — the removed prose was largely the "why", and that is what makes a rule
survive contact with an agent that has a reason to break it. If a specific rule now reads as
arbitrary where it used to read as earned, that is the regression to flag.

`docs/refactoring-candidates.md` had this slim-down recorded as a deferred follow-up, with a stale
line count; its entry now describes what landed and narrows the remainder to relocating the flows
that have no ADR/initiative doc of their own into `docs/flows/*`.
