---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/observability-otel': minor
'@cat-factory/contracts': minor
---

Refuse a blind run: the harness now tells the backend which job-body capabilities it parses

An image older than a body capability does not reject the field, it ignores it. For most of the
job body that degrades honestly, but a CAPABILITY is different: the backend composes the PROMPT,
so a dropped `mcpServers` leaves the agent reading "you have these tools, prefer them over
guessing" with no client wired, and a dropped `skills` leaves a claude-code run told a playbook
"is installed for this step" that was never written. The harness CHANGELOG has documented this
twice as an operator hazard, both times ending at the same wall: the backend has no way to know
what image a self-hosted runner pool pins, so it could not be gated server-side. A blind run
rather than a failed one, and the run that most needs a signal produced none.

The handshake is a list of body field names the image reports on `/health` and on its job
ACCEPTANCE. The acceptance is where it matters: the dispatch site is the only place the body it
just sent is still in scope, and the last moment before the agent starts working from a prompt the
body cannot back up. `RunnerTransport.dispatch` therefore returns an optional ack, forwarded by
every transport that can see the harness's own response.

The answer is deliberately THREE-STATE, and the middle state is the whole design. An image that
reported nothing is not an image that reported "not this": every image between the capability
landing and the handshake landing serves it perfectly and reports no list, so folding the two
would refuse those runs on no evidence. So `unsupported` (the image said it cannot) refuses the
dispatch and stops the job the harness already started, as an `UnavailableError` whose
`runner_image_capability` reason makes the step a `preflight` fault rather than a container that
died; `unknown` proceeds and is REPORTED as the deployment's own blind spot, on a warn line and a
`container.capability_unknown` counter that should decay to zero as pools update. A body carrying
no capability says nothing at all, which is most dispatches.

Refusing the step is only half of it: the harness begins work on acceptance, so a refusal that
merely throws leaves a full agent pass running against the repository, free to push a branch and
open a pull request for a step the engine already failed. The refusal therefore STOPS the job,
through a new `RunnerTransport.stopJob` and a new harness `DELETE /jobs/{id}` that aborts one job
and waits for it to settle before answering. Never through `release`, which is a reclaim and means
something different on every backend: on a per-run container it happens to kill the job, on a warm
pool member it hands the container BACK with the agent still working in it, and on a self-hosted
pool with no `release` template it does nothing at all.

Not every backend can PROVE the job died, so the outcome is reported rather than assumed and the
failure message says which of four it was: `stopped` (nothing is still running), `requested` (a
pool cancel was accepted but cannot be verified), `unsupported` (no cancel path exists), `failed`.
The last three also increment `container.blind_job_not_stopped`, dimensioned by the outcome,
because each is a different operator fix. A backend that owns the container always reaches
`stopped`, since a graceful abort that fails escalates to destroying it; on the local warm pool
that escalation is also what keeps a member whose job could not be aborted off the idle list, where
it still answers `/health` and the next run would lease a container with a live agent and a live
checkout in it.

A runner pool gets the handshake only when its manifest MAPS it: `response.dispatchCapabilitiesPath`,
one line for a pool that proxies `POST /jobs` verbatim. Deliberately not read by name, because
`capabilities` is an ordinary word for a scheduler to use about its own runners (`["gpu","docker"]`)
and reading one of those as the harness's answer would narrow to an empty list and hard-refuse every
capability dispatch against a perfectly current image. Unmapped lands in `unknown`, which is honest
about a control plane this backend knows nothing about.

OPERATORS: this bumps the runner image to `1.93.0`. A pool on an older image keeps working exactly
as before; it simply reports no handshake, so tool-server and skill dispatches there are counted as
unverifiable instead of confirmed. To get the check on a self-hosted pool, map
`response.dispatchCapabilitiesPath` to `capabilities` and declare a `release` template so a refused
run can actually be cancelled.
