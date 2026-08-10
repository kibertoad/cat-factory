---
'@cat-factory/cli': minor
'@cat-factory/app': patch
---

`cat-factory k3s` no longer promises an ingress-derived environment URL it has not established, and
can recreate a local cluster.

An ingress-template URL needs two things: an ingress controller inside the cluster, and a host port
published into it. The command assumed both. It published no host port when creating a k3d cluster
(k3d forwards only the ports asked for at create time), created kind clusters with neither the port
mapping nor an ingress controller, and checked nothing at all when reusing an existing cluster. The
printed summary and the SPA connect-form deep link then named `{{branch}}.127.0.0.1.nip.io` as
wired. Provisioning still succeeded, because environment readiness is workload readiness, so the
failure surfaced later at the `tester` step against a URL that answered nothing.

Now: a create publishes the port (`--ingress-port`, default 80), and every path probes both halves
and reports one of three outcomes (verified, verified-missing with the fix, or could-not-tell). An
unestablished ingress withholds the host-template prefill rather than filling the form with a
promise, and the summary says what is missing and how to get it.

New `--recreate`: destroy a named k3d/kind cluster and build it again from the current flags, which
is the only way to change a published host port. It names what is on the cluster before deleting it,
only ever targets a k3d/kind cluster the CLI can name, and is never selected for you (`--yes` alone
cannot pick it).

Breaking for anyone scripting the hand-off: the deep link now carries `scheme=http` (a local ingress
controller's TLS is self-signed) and omits `hostTemplate` when the ingress was not verified.
