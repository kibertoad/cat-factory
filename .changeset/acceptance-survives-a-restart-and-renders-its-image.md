---
'@cat-factory/acceptance': patch
---

Stop the acceptance suite dying on a deployment restart, and refuse a pass whose manifests could
never name an image.

Two independent failures from one pass, found in that order. The reported one was a scaffold run 41
minutes in, coder and reviewer done and a pull request open, whose next `GET /tasks/:id/run` threw
`connect ECONNREFUSED 127.0.0.1:8787` and took the scenario with it. Nothing was wrong with the run:
the local deployment's `node --watch` had cycled the process between two polls, it was serving again
seconds later, and the run went on to reach its deployer step with nobody watching. That is not an
exceptional environment. The suite's own README points it at a stack run under `cat-factory
supervise`, a supervisor whose entire job is to restart the backend when it stops serving, in front
of a watcher that cycles it on a file change, so over an afternoon a restart is ordinary and a wait
that cannot sit through one is a wait that reports the watcher's death as the run's.

So an unanswered poll is now an observation for two minutes rather than an immediate failure. The
policy is injected into `waitFor` rather than built into it (the clock knows nothing about
deployments) and classifies through the suite's existing `describeProbeFailure` rather than matching
messages, so there is still one reading of a thrown probe. What it tolerates is the ABSENCE of an
answer: an answered refusal ends the wait and is rethrown untouched, because a refusal is evidence
and because callers read the SDK error's status and request id off it. The recovery is journalled as
well as the outage, since an unexplained gap in a long observation log is how a restart becomes
invisible.

The second failure is why that pass would have failed anyway, and it had never been reached before:
every previous attempt stopped in preflight, so the deployer step ran for the first time. It failed
with `Deployment.apps "catalog-api" is invalid: spec.template.spec.containers[0].image: Required
value`. The manifest was correct. The briefs make `{{image}}` mandatory and the agent emitted it
verbatim; the platform substitutes that hole from the workspace connection's `imageTemplate`, this
suite set none, and an unfilled hole renders as the empty string, so `image: ""` went to the
apiserver. The suite now configures the template (`ACCEPTANCE_K3S_IMAGE_TEMPLATE`, defaulting to
GHCR under the repository's own owner), threads it into the briefs exactly as it already threads the
ingress host, and grades it in a new required `image-template` prerequisite before anything is
spent.

The default tags by pull-request number rather than by commit sha, which is the interesting
constraint: a provision carries no sha (`ProvisionContext` has branch, number, url, owner, name),
and `{{branch}}` is `cat-factory/<taskId>`, which no image tag may contain. The gate refuses both of
those mistakes by name, and its PASS states what it did not check: nothing readable from here says
whether anything published that reference or whether the cluster may pull it, and both present as an
environment that provisions and never becomes ready.
