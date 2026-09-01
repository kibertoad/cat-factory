---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
---

An environment now carries an address as well as a name, and the platform proves the route before a tester is pointed at it

An environment reached an agent as one nullable URL, so "reachable" meant "a URL exists" and
nothing between the provider stating it and a tester dialling it ever checked. The tester then got
`curl` code 000, which covers a DNS failure, a missing route and a refused connection as one
symptom, and reported the hypothesis its own task made salient: that the environment was down.

Three things change together, because landing any one alone is incoherent or worse than today. A
host bridge can now map a name to an ADDRESS as well as to the container runtime's host gateway,
which is what a per-PR environment whose DNS record lives in an internal view needs. The deployer
DIALS the environment once when its frame settles ready, publishing the candidate that carried
rather than the first that resolved and recording every attempt either way. And what it proved
rides the handle into the tester's prompt, so an agent that cannot resolve a name is told which
layer the platform already ruled out and which address carried.

An environment nothing can reach now settles the frame `failed` with the new
`environment_unreachable` reason, in about two minutes, rather than being handed on for a tester to
spend ten minutes and a model budget misdiagnosing. That failing verdict is deliberately the narrow
one, because a wrong "unreachable" kills a healthy deploy while a wrong "could not tell" costs one
diagnostic: a probe that could not classify its own failure, an environment with no address to dial
(a `ready` service that publishes no ingress), and a facade with nothing wired to open a socket are
`inconclusive` or `unproved`, and neither fails anything. The agent is told when a check was
inconclusive; a deployment with no prober carries no reachability line at all.

The addresses the platform will dial are limited to those a host bridge may name, applied when the
probe is PLANNED rather than only when a bridge is built, so a provider-authored address list
cannot aim the platform's own outbound socket at loopback or a cloud metadata endpoint. A refused
address is recorded on the proof rather than silently dropped.

Internal breaks, both deliberate: `RunnerDispatchOptions.environmentUrls` becomes `environments`,
a list of `{ url, address? }` (the pairing is what keeps the host side of a bridge a host the job
was actually handed), and `planEnvironmentBridges` moves from the local runtime into
`@cat-factory/integrations`, where the Kubernetes runner transport builds the same bridges as pod
`hostAliases`. Existing environment rows carry no addresses and no proof, which reads exactly as it
should: nothing has looked yet.
