---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/integrations': patch
'@cat-factory/acceptance-kit': patch
'@cat-factory/local-server': patch
'@cat-factory/kernel': patch
'@cat-factory/cli': patch
---

Stop publishing an ephemeral-environment URL nothing can serve, and make a containerized tester
able to reach one that can.

An acceptance pass deployed a healthy pod, published `http://cf-acc-pr8.127.0.0.1.nip.io`, reported
the environment `ready`, and then spent fourteen minutes in the tester on curl code 000 before
failing the run at forty-three minutes. Two independent faults, both of which PR #2075 named and
left open:

- **The Ingress was claimed by nothing.** It declared `ingressClassName: nginx` on a cluster
  running Traefik. The apiserver accepts that, no controller watches it, `status.loadBalancer`
  stays empty, and readiness (which was the Deployments' rollout and nothing else) still said
  `ready`. The Kubernetes provider now grades a template-derived URL against the cluster's own
  `IngressClass` catalog and reports `failed` / `config_incomplete` naming both the requested class
  and the available ones. It fails only on POSITIVE evidence that no controller can claim the
  Ingress; a missing address is `pending`, never a refusal, and a cluster that will not answer the
  cluster-scoped read passes through byte-for-byte as before. `cat-factory k3s` grants the
  `ingressclasses` read so a cluster it provisions can answer.
- **A loopback URL is unreachable from an agent container**, whose `127.0.0.1` is its own network
  namespace. The local facade now maps the environment's host to the container's host gateway, so
  one URL means the right thing to the operator's browser and to the agent alike. A container that
  predates its environment is replaced, and a bridged job never takes a warm-pool member (a member
  is re-leased across runs, so one run's per-PR entry would leak into the next). It covers every
  environment a job is handed, not just the frame's own: a live peer service's environment for a
  cross-service test and a frontend flow's resolved backend binding fail identically without it.
  The URLs ride the dispatch OPTIONS as a declared, typed list rather than being dug back out of
  the job body, where they sit three levels down under a wire shape the harness owns.

  A URL naming this machine that NO bridge can re-point is reported rather than bridged: a hosts
  entry cannot displace the `127.0.0.1 localhost` line an image ships with, and it is never
  consulted for a bare IP literal. A compose environment publishes `http://localhost:<port>`, so
  bridging it bought nothing while costing every such run its warm-pool member and a container
  replacement. Those runs are pooled again, and the log now says the environment is out of the
  agent's reach instead of leaving it to be discovered as a dead cluster.

Also: the acceptance suite refuses a pass up front when the cluster runs no ingress controller or
publishes no host port into it, reusing `cat-factory k3s`' probe; its scaffold briefs tell agents to
leave `ingressClassName` unset so the cluster's default class claims the Ingress; and the run driver
reports step TRANSITIONS instead of only sampling `currentStep`, so a step that starts and finishes
between two polls is still named. That last one is why this failure was misread: the `deployer`
finished in one second against a ten-second poll, so the pass jumped from `reviewer` to
`tester-api` and the step that published the bad URL never appeared in the log at all.

Alongside them, `/api/v1` serves `skipped` on a run's steps (an additive optional field, OpenAPI
`1.62.0`). A skipped step's `state` is `done` with no output, which is byte-for-byte a step that
ran and produced nothing, so following a run's chain could not tell the engine deciding a step was
unnecessary from the step happening and having nothing to say. The acceptance kit's transition
reducer already knew how to announce the difference and could not observe it.
