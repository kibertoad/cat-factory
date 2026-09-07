---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Test whether an agent can actually operate a service's ephemeral environment, before a pipeline finds out

"Test environment creation" answers whether a service's provisioning stands an environment up and
takes it down again. The expensive failure is the one after that, and it is a GREEN deploy: the
environment is up, the tester reaches it, and the agent then spends its whole step
reverse-engineering an auth flow, guessing a base path, or reporting the service as broken because
nobody told it which credential to send. That is a full run spent to discover a missing sentence of
configuration.

"Test agent dry run" sits beside it on the same service and buys the same finding for one
container. It runs the identical lifecycle against a throwaway branch and adds one stage in the
middle. The environment is handed to an agent (HTTP for a backend service, a browser for a
frontend frame) together with the frame's sealed test credentials, the provider's own access
handle and a read-only checkout of the branch the environment was built from. The agent picks a few
simple but meaningful operations, at least one of which must go through authentication, attempts
them, and reports each one: what it was, how it was performed, whether it exercised auth, and what
happened. Then the run tears the environment down and deletes the branch exactly as before.

The report's most valuable field is the one listing what the PLATFORM failed to supply (a
credential with no reference, an endpoint that could not be discovered, an auth flow that had to
be reverse-engineered), because each entry is a thing to fix before a real run spends a step on
it. An operation the agent could not even attempt is a first-class outcome carrying the reason,
not a failed call, and the failure vocabulary is grouped by whose problem each kind is: "no credential
was supplied" and "the credential I was given was refused" are different fixes and therefore
different members.

The verdict is computed by the platform from the agent's per-operation judgements, never read off
the reply, and it will not call a service operable unless something that worked went through
authentication: a healthcheck answering 200 proves an ingress exists and nothing about whether an
agent can work there.

Two things to watch when reviewing. The run's `status` deliberately stays a statement about the
LIFECYCLE, so a dry run reporting `inoperable` is a SUCCEEDED run that found something. Folding
the verdict in would make the one interesting outcome indistinguishable from a broken diagnostic
and leave a real teardown failure with nothing to say. And a deployment that cannot drive a dry run
(no container runner, no proxyable model, no repository seam) refuses the mode as a 409 before any
side effect, rather than standing an environment up and parking at a stage nothing can advance.

Internal break: `environment_test_runs` gains `mode`, `probe_surface` and `probe` on both
runtimes, and the start endpoint takes an optional `{ mode }` body (absent is the provisioning
self-test, so an existing client is unchanged). The reasoning, the traps and the wiring:
`backend/docs/environment-self-tests.md`.
