---
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
  is re-leased across runs, so one run's per-PR entry would leak into the next).

Also: the acceptance suite refuses a pass up front when the cluster runs no ingress controller or
publishes no host port into it, reusing `cat-factory k3s`' probe; its scaffold briefs tell agents to
leave `ingressClassName` unset so the cluster's default class claims the Ingress; and the run driver
reports step TRANSITIONS instead of only sampling `currentStep`, so a step that starts and finishes
between two polls is still named. That last one is why this failure was misread: the `deployer`
finished in one second against a ten-second poll, so the pass jumped from `reviewer` to
`tester-api` and the step that published the bad URL never appeared in the log at all.
