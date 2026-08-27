---
'@cat-factory/executor-harness': minor
'@cat-factory/deploy-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
---

Move the harness job server off `:8080`, so a tester grades the product rather than the platform.

The harness is PID 1 of the job container and shares its network namespace with everything the
agent starts, and it held 8080: the most common default for a containerised HTTP service. A
service under test started on its own documented default died with `EADDRINUSE`, and a health
check aimed at 8080 got a 200 back from the harness, whose body begins `{"status":"ok"}`. Every
ordinary health assertion passes against that, so a step could report green on a service that
never ran.

Both images (executor and deploy) now bind `27182`, and the four backend copies of the number
collapse onto one `HARNESS_JOB_PORT` in `@cat-factory/contracts`, pinned to each harness's own
literal by a conformity test. The environment inventory the harness states to every agent now
names the port it holds and says a reply from it is not evidence, which stays true for a
deployment that overrides `PORT`.

Moving the number is not on its own the fix, because the harness exports the port it holds as
`PORT` and the agent's own processes inherited it: a service written as `listen(process.env.PORT)`
would have been aimed straight back at the one address in the namespace it cannot have. `PORT`
joins `NODE_ENV` on the short list of harness variables stripped from everything spawned into the
checkout, so the collision is closed rather than relocated.

Two things now hold the port in one place per job. Every facade STATES the port the container must
bind rather than leaving it to the image: the Kubernetes pod spec already did, and the local
container adapters and the Cloudflare container class now do too. A deployment pins its own
mirrored image tag, so without that the published port and the served one were joined only by the
image happening to agree, and a tag from before this change would answer nothing and surface as a
container that never became ready (rather than as the version handshake naming the skew, which
needs a reachable harness to run at all). And the frontend stand-up refuses a serve port equal to
the port the harness is listening on, read from the live process rather than predicted from the
shared constant, which is what covers a deployment whose `PORT` the constant does not name.

Breaking for a deployment that pins the harness port itself: a runner pool's pod spec, a
`NetworkPolicy`, or a `harnessPort` runner-backend setting written against 8080 must move with the
image tag. **A pool left on `harnessPort: 8080` keeps dispatching, which is the trap rather than
the relief**: the harness then holds 8080 inside every job container, exactly the collision this
change removes, and a `frontend` frame is free to be configured to serve there because the shared
guard now reserves 27182. The stand-up refusal above is what makes that land as a named infra gap
instead of a green grade against the platform, but the pool setting is still the thing to clear.
