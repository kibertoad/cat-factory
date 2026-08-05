---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/observability-otel': minor
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

Two things worth a reviewer's attention. The refusal releases the job before throwing, because the
harness begins work on acceptance and a refusal that left it running would let a blind agent
finish, possibly opening a PR for a step the engine has already failed; the release is best-effort,
so a failed reclaim cannot replace the accurate refusal with a teardown error. And a runner pool
gets the handshake only if its scheduler passes the harness's acceptance body through. It is read
off that response directly rather than through a manifest mapping, since the field is the
harness's and not the scheduler's, so a pool that does not forward it lands in `unknown`, which
is honest and counted rather than quietly treated as a pass.

OPERATORS: this bumps the runner image to `1.93.0`. A pool on an older image keeps working exactly
as before; it simply reports no handshake, so tool-server and skill dispatches there are counted as
unverifiable instead of confirmed.
