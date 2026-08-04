---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Judge a pushed tracker issue against a schedule's intake scope, and let each dispatch mode decide
what an unanswerable predicate means.

The push matcher reported a boolean and failed OPEN on any field a delivery did not carry, which was
correct for the queue mode it was written for: the fired run's vendor search re-checks every
predicate, so the worst case is one no-op run. Per-ticket dispatch reused it with nothing downstream
to re-check, where the same guess costs a real task block and a real agent run on a ticket nobody
triaged.

It now reports a verdict (`match` / `miss` / `unconfirmed`) and `dispatchAdmits` picks the
disposition per mode: `queue` still fires on an unconfirmed predicate, `per-ticket` withholds and
logs which predicate it could not confirm.

Board scope is evaluated for the first time. `TrackerIssueEvent` carries the vendor board in the
shape the intake config stores (a Jira project key, an `owner/repo` slug, a Linear team UUID), read
from payloads the adapters already parse, so a per-ticket schedule scoped to one project no longer
runs tickets from every project its connection can see. This tightens the queue mode too: a delivery
from a board the schedule is not scoped to no longer fires it. That only ever spent a run which
completed as "no matching open issues", so the change removes wasted runs rather than pickups.

The schedule form locks on-demand while the tracker trigger is on, rather than only defaulting it,
and both intake refusals carry a machine-readable reason mapped to translated copy.
