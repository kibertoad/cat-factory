---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Bootstrap a new service INTO an existing monorepo, with a human review of what it adopts.

Repo bootstrap only ever created a service in a repository of its own: clone a reference
architecture, adapt it, force-push a single commit to a fresh empty repo. That shape is exactly
wrong for a monorepo, which already holds other people's services: there is no empty target, the
force-push would destroy them, and the question worth asking is not what the service contains but
what it should share with everything around it. A bootstrap can now target a DIRECTORY of a
repository the workspace already has, and it is delivered as a pull request.

That question has no good default, which is why the run stops to ask. The template ships its own
build tooling, lint config, test runner, CI wiring and layout; the monorepo has answers for the
same areas, usually different ones. Adopt the template wholesale and the repository grows a second
toolchain; adopt the monorepo wholesale and the template stops being worth having. So a monorepo
run is two phases with a person between them: it surveys both sides, proposes per-area
recommendations, parks on a new `awaiting_review` status, and writes nothing until a human has
settled every line.

The suggestion is built to be CHECKED rather than trusted. The platform reads a bounded, declared
set of files through the checkout-free repo port (the root manifests, the CI workflows, and the
nearest EXISTING sibling service, which is the only thing that says what a service in this
repository actually looks like), and the model only judges what it was given. A recommendation
whose evidence names no file the survey read is dropped before it reaches the reviewer, and the
plan reports the drop rather than quietly shortening: a plan that lost half its lines to invention
must not look like a monorepo with few conventions. What the survey could not read is reported
apart from what is simply absent, for the same reason.

Two refusals are load-bearing. A review that leaves a decision unanswered is refused rather than
defaulted onto the recommendation, because agreeing with a suggestion and never having read it are
the two things this step exists to tell apart. And an answer naming a decision the plan does not
carry is refused whole, since the reviewer was looking at a different proposal. Where no model is
configured at all, the run still parks and the reviewer is told the platform had nothing to offer
and why. An empty decision list and "the analysis never ran" lead to opposite conclusions.

The apply phase is an ORDINARY coding job rather than a bootstrap one: the monorepo as the
writable primary at a work branch, the reference template beside it as a read-only checkout the
run is structurally incapable of pushing to, and one pull request. Nothing outside the new
directory is touched beyond the registration the monorepo's own tooling needs, and nothing is
merged for the reviewer.

`BootstrapStatus` gains `awaiting_review`, which reaches `/api/v1` (surface 1.65.0) because a run
started in the app is read through it. It is additive (the clients tolerate unknown enum values),
but a poller's terminal test has to change: `awaiting_review` is neither running nor finished, so a
loop treating "not succeeded and not failed" as "still working" would wait forever on a run that is
waiting for a person.
