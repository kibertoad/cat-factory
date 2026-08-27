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

Breaking for a deployment that pins the harness port itself: a runner pool's pod spec, a
`NetworkPolicy`, or a `harnessPort` runner-backend setting written against 8080 must move with the
image tag. A `frontend` frame configured to serve on 8080 is no longer bumped to 4173, since that
port is now free.
