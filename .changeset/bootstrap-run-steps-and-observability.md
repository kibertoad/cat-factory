---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Bootstrap runs are legible: their steps are shown, their details are inspectable, and a retry resumes where the run stopped

A repo bootstrap was already a first-class agent run in every way that costs something to build
(one `agent_runs` table, one retry surface, one stop surface) and in no way that helps a person
watching one. It rendered as a single "bootstrapping…" bar, so a monorepo bootstrap's three moves
(survey both repositories → your adoption decisions → write the service and open the pull request)
were invisible, and the control under that bar said "Retry bootstrap" while the service actually
resumed at the phase the run reached, carrying the reviewer's settled decisions forward.

The steps are now derived from the run row by one rule in `@cat-factory/contracts` that both sides
read: the board renders them on the in-progress, parked and failed cards, and
`BootstrapService.retry` branches on the same function, so the button names the step it resumes
from and cannot promise one the service does not re-enter at. Where a run GOT to and where a retry
RESUMES are separate questions, because they differ on one case: a run parked on a plan the
platform could not produce reached the review, but the retry drops that plan so a fixed deployment
can produce a real suggestion, and re-surveys.

A bootstrap is also inspectable through the observability panel now, over the same routes and the
same four sinks as any other run. It had been filing almost nothing: no provided-context snapshot,
no tool-call trajectory, and its apply phase's model calls keyed on the run's DRIVE id, which no
run-scoped read asks for. The drive id now addresses the container and nothing else; every sink
carries the run. The inline monorepo survey tags its loop with the run too and files its own
context snapshot, so its prompt and its spend read beside the apply's instead of sitting in the
store outside every read that could find them. What the panel cannot answer for a bootstrap (the
per-phase rollup and the run's cost, both folded from an execution's steps) it now SAYS, rather
than hiding the section: beside a list of calls that plainly cost something, a missing cost tile
reads as a run that cost nothing.

Stopping a bootstrap no longer reports itself as a failure of the step it was stopped in. A stop
is stored as a failed status with a `cancelled` kind, so a stopped monorepo run used to paint the
reviewer's own decision step red; it is now its own step state.

Two behaviour changes worth knowing: a bootstrap's model calls are filed under the agent kinds
that actually ran (`repo-bootstrapper`, `monorepo-adoption-advisor`) rather than under `architect`,
which changes how new rows group in per-kind spend rollups (the container still resolves its MODEL
through `architect`'s routing); and `MonorepoAdoptionSubject` gains a required `runId`, so a
deployment that injects its own `MonorepoAdoptionAdvisor` implementation gets the run id it needs
to tag its calls with. The two kind strings are exported from `@cat-factory/contracts`
(`REPO_BOOTSTRAP_AGENT_KIND`, `MONOREPO_ADOPTION_AGENT_KIND`), which is where anything naming
them should now read them from; `@cat-factory/agents` no longer exports the second.
