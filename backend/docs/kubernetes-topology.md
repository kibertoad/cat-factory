# Running cat-factory on Kubernetes

> **Laying out a cluster is on the website**
> ([Lay Out a Kubernetes Cluster](https://www.catfactory.ai/deploy/kubernetes-topology.html) for the
> topology, [Deploy on Kubernetes](https://www.catfactory.ai/deploy/kubernetes.html) for the connect
> form). That page owns what runs where, the control-plane / data-plane split, the RBAC verbs, the
> egress set, reaping and sizing. This page is the handful of decisions a change to the
> `kubernetes` runner backend has to keep true.

The backend is the `kubernetes` entry in the app-owned `RunnerBackendRegistry`
(`packages/integrations/src/modules/kubernetes/`): `KubernetesRunnerTransport` drives the apiserver,
and `kubernetes.logic.ts` is the pure half (pod naming, the pod spec, the pod-proxy URL builder).
The registration API and the job protocol it speaks are
[`runner-pool-integration.md`](./runner-pool-integration.md) and
[ADR 0004](./adr/0004-self-hosted-runner-pool.md). The `manifest` backend reaches Kubernetes through
a scheduler service you run instead, and the two differ only in the dispatch hop.

Do not conflate this with the **environment-under-test** axis, which uses the same apiserver client
for a different job: [`per-service-provisioning.md`](./per-service-provisioning.md).

## One pod per RUN, and a re-dispatch re-attaches to it

The first step of a run creates one pod named `cf-run-<runId>`; every later step dispatches to the
same pod. **A `POST pods` answering `409 AlreadyExists` is an idempotent re-attach, not an error**,
because the durable driver replays: treating it as a failure would fail a run whose pod is up and
healthy, and creating a second pod would strand the checkout the first one holds. `release` deletes
the pod, once, when the run no longer needs it.

Dispatch and poll reach the harness through the apiserver **pod-proxy subresource**
(`…/pods/<name>:<port>/proxy/…`, `DEFAULT_HARNESS_PORT` 27182). The run pod deliberately has **no
Service**: the RBAC-gated pod-proxy is the only route in, which is what lets the harness run with no
inbound shared secret of its own. Giving a run pod a Service would remove that property silently,
since nothing would fail.

## Why a bare Pod and not a Job

The harness is a long-lived HTTP server whose lifecycle the engine owns (create on first dispatch,
delete on release), and Job completion semantics fight that. The cost of the choice is that a bare
Pod (`restartPolicy: Never`, no owner reference, no Job TTL) is **not garbage-collected**, so
`release` is the only reclaim and a failed release leaks the pod. Every pod carries a
`cat-factory.runId` label so a deployment can sweep leaked ones; the website page tells operators to.
A change that makes release less reliable is a change that leaks node slots.

## The apiserver URL is SSRF-guarded, and the guard allows private hosts

`assertApiServerUrlSafe` requires `https` and rejects the cloud-metadata endpoints (including their
obfuscated IP encodings) while allowing a private cluster IP or cluster DNS name: the operator is
pointing at their own cluster on purpose. A custom CA (`caCertPem`) or `insecureSkipTlsVerify` needs
undici, so both are refused at registration on the Cloudflare Worker rather than failing mid-run.
The connect-form fields themselves are the website's.

## Manifest variant: the routing rule the scheduler owns

With the `manifest` backend the node-server never touches the apiserver; it calls the registered
scheduler with `dispatch` / `poll` / `release` and the scheduler performs the cluster operations. One
rule crosses the boundary and cannot be enforced from this side: **the scheduler must route by
`jobId` stickily**, because a durable replay re-dispatches the same id and a scheduler that treats it
as new duplicates the work. The natural shape there is one Kubernetes Job per pipeline step
(`jobId = <executionId>-<agentKind>`) rather than the native backend's one bare Pod per run, which is
also what gives it a Job TTL as a reaping backstop.

The manifest format is the website's, and what a change here owes it (the schema's location, the
single generic interpreter) is stated once in
[`runner-pool-integration.md` §3](./runner-pool-integration.md#3-describe-your-scheduler-as-a-manifest-application-team),
not repeated here.
