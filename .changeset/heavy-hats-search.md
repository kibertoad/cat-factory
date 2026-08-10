---
'@cat-factory/cli': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
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
promise, and the summary says what is missing and how to get it. Where the cluster is one the CLI
can name, the port half is settled against the container runtime's own port table, so a host port
answered by something other than the cluster is reported as the gap it is instead of as ready.

New `--recreate`: destroy a named k3d/kind cluster and build it again from the current flags, which
is the only way to change a published host port. It names what is on the cluster before deleting it,
only ever targets a k3d/kind cluster the CLI can name, and is never selected for you (`--yes` alone
cannot pick it). `--recreate --runtime k3s` is refused: k3s is a host service, not a cluster this
command can delete and build again.

The `ingressTemplate` environment URL source gains an optional `port`, on `/api/v1` (OpenAPI
`info.version` 1.42.0, so the four SDK clients gain the field) and on the internal handler config
alike. Additive, and existing configs are unaffected. A non-default host port needs its own carrier
because the rendered `hostTemplate` is also the Ingress `spec.rules[].host` a service's manifests
declare, and Kubernetes rejects a `host` with a port in it: folding the port into the template gave
the right URL and an invalid manifest. Both connect forms gain the field beside the host template.

Breaking for anyone scripting the CLI hand-off: the deep link now carries `scheme=http` (a local
ingress controller's TLS is self-signed) plus `ingressPort` for a non-default port, and omits
`hostTemplate` when the ingress was not verified. `buildK3sHandler` now returns `null` for a
connection whose ingress was not established (there is no honest `url` block to register), and
`buildK3sSetupUrl` takes the resolved connection rather than a built handler plus a verification
flag.
