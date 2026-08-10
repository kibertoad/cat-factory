# ADR 0008: Local k3s guided setup; probe/provision via the CLI, hand off to the SPA

- **Status:** Accepted (implemented)
- **Date:** 2026-07-01
- **Context layer:** `@cat-factory/cli`, frontend (`app/`),
  `backend/docs/local-k3s-environments.md` + `local-kubernetes-setup-windows.md`.
  Reuses the `local-k3s` engine + the `environments/handlers/test` probe from ADR 0007 /
  the per-service-provisioning work: adds no backend endpoint.

## Context

In local mode a developer who wants the Tester to provision ephemeral environments on a local
Kubernetes cluster had to do everything by hand: install/start a cluster (k3s / k3d / kind),
create a ServiceAccount + RoleBinding, mint a token, find the apiserver URL, and paste all of it
into the Kubernetes engine form. That is a lot of out-of-band `kubectl`/install ceremony for a
"just run it locally" product, and every step is a place to get a value subtly wrong. PR #557
closed the _feedback_ gap (loopback prefill + a **Test connection** probe) but the user still ran
every command themselves.

**Target end state:** cat-factory can **probe** the host for a usable cluster and, with a few
confirmations, **provision one and wire the handler on the user's behalf**: create (or reuse) a
local cluster, create the ServiceAccount + RoleBinding, mint a token, read the apiserver URL from
the kubeconfig, wire the `kubernetes` infra handler, and verify it with the existing connectivity
probe. The manual form stays as the escape hatch / advanced path.

## Decisions

### 1. Hybrid, CLI-primary: the CLI owns all privileged host work

The orchestrator backend is a non-interactive HTTP server (no TTY), so the interactive,
privileged part cannot be a bare "prompting" endpoint. The guided flow lives in
**`@cat-factory/cli`** (`cat-factory k3s`), which already has an injectable IO + FS seam, a tested
pure-function core, and `@clack/prompts` for the interactive UI: the natural home for privileged
setup (a `sudo` k3s install). The rejected alternative (an in-app SPA wizard driving new
local-mode backend endpoints that shell out on the host) would push a privileged host-shell
capability into the HTTP layer and still couldn't `sudo`. The SPA covers the UI angle via a
**deep-linked hand-off**, not a host-shelling backend.

### 2. Probe → offer → provision → hand off (all mutating steps confirmed)

`setupK3s` drives: **probe** the host (a reachable cluster via kubeconfig, a running k3d/kind via
Docker, installed CLIs) → **offer** a small selection (_use existing_, _create a k3d cluster_
(Docker, no root, the default) or _show the k3s install command_; needs sudo, guided not run) →
**provision** the chosen setup → **hand off**. Pure planners (`classifyHost`,
`k3s-provision.ts`'s command specs + rendered manifest) sit behind a thin `HostShell` shell-out
seam (`run`/`which`, a `scriptShell` fake for tests), mirroring `ContainerRuntimeAdapter` /
`NativeCliDeployTransport`, so the whole flow is unit-tested without a real cluster.

Safety invariants: **local mode only** (never wired off-local); **every** mutating step (cluster
create, RBAC apply) requires an explicit confirmation naming the target context + apiserver
(skipped only by `--yes`); the k3s `curl | sh` install is **printed, never run**; `--yes` refuses
to mutate a reachable cluster that doesn't look local. The flow is **idempotent**: probe-first,
reuse an existing cluster, `kubectl apply` reconciles the SA/RBAC.

### 3. Least-privilege RBAC + a long-lived token; k3s/k3d/kind are one preset

Provisioning applies a namespace + ServiceAccount + a **scoped** ClusterRole/binding (the env
backend's manifest kinds + `namespaces` create/delete + `pods`/`pods/proxy`: **never
`cluster-admin`**) plus a long-lived `kubernetes.io/service-account-token` Secret (k8s ≥ 1.24 no
longer auto-creates one), chosen over a short-lived `kubectl create token` so the wired handler
doesn't silently expire. Credential-bearing kinds get single-object verbs only, never cluster-wide
`list`/`watch` (which on a single-node cluster would be effectively cluster-admin). The manifest is
piped to `kubectl apply -f -` via a stdin seam, never a temp file. k3s / k3d / kind are one preset:
the same `local-k3s` handler shape, varying only the apiserver URL/port read from the kubeconfig.

### 4. Hand-off = emit values + deep-link the SPA form; the token is never in the URL

After provisioning, the CLI prints the resolved connection and opens a **deep-link** into the SPA's
Local k3s connect form pre-filled with the **non-secret** fields
(`?infraSetup=local-k3s&label=…&apiServerUrl=…&namespaceTemplate=…&hostTemplate=…&insecureSkipTlsVerify=1`;
`buildK3sSetupUrl`). The ServiceAccount **token is deliberately omitted** (a secret in a URL leaks
into history/logs) so the CLI prints it once and the user pastes it. The SPA reads the query on
load (`useUiStore().consumeK3sSetupDeepLink`), opens Infrastructure → Test environments seeded from
the params, and strips the params from the URL (mirroring the `?invite=` handling). The form also
surfaces an in-app **Auto-setup with the CLI** hint showing the `cat-factory k3s` command.

### 5. Verify reuses the existing probe, no new backend endpoint

The "verify" step is unchanged from #557: the user runs **Test → Save**, reusing
`EnvironmentConnectionService.testHandler` (`POST /workspaces/:ws/environments/handlers/test`) +
`registerHandler`. The CLI therefore needs no local-mode auth or workspace-id knowledge. A
hands-free `--register` flag (the CLI POSTing the handler directly) is a documented, deliberate
follow-up, not built.

## Consequences

- `@cat-factory/cli` keeps its single `@clack/prompts` runtime dep: the handler shape is mirrored
  **structurally** in the CLI, with `@cat-factory/contracts` a devDependency only; a unit test
  parses a built handler through the real `registerEnvironmentHandlerSchema` so any drift fails.
- The deep-link contract (query param names) is shared by two packages with no runtime coupling:
  the CLI's `buildK3sSetupUrl` and the SPA's `consumeK3sSetupDeepLink` / `K3sSetupPrefill`.
- The manual runbook survives as the advanced path; `local-k3s-environments.md` /
  `local-kubernetes-setup-windows.md` now lead with the guided command.
- Still future (see `local-k3s-environments.md` "managed local k3s lifecycle"): local mode owning
  the cluster's ongoing lifecycle (idle tear-down, local-image import, run-UI bring-up progress)
  and the hands-free `--register`.

## Amendment: the ingress promise is PROBED, and a cluster can be recreated

Decision 4 above shipped a FIXED hand-off: the deep link and the printed summary always named the
`{{branch}}.127.0.0.1.nip.io` ingress host template. That was a capability claim the flow never
established. An ingress-derived URL needs an ingress controller in the cluster AND a host port
published into it, and a local distribution forwards only the ports asked for at cluster-create
time. The create path published none, kind ships no controller at all, and the reuse path looked
at neither, so an operator could be told the template was wired against a cluster that could not
serve it. Nothing failed at provisioning (environment readiness is workload readiness), so the
consequence landed at the `tester` step against a URL that answered nothing.

What changed, all inside `@cat-factory/cli`:

- **The create path publishes the port** (`k3d -p`, kind `extraPortMappings` + the
  `ingress-ready` node label, both create-time-only), configurable with `--ingress-port`.
- **`k3s-ingress.ts` PROBES both halves** and answers in three states, `unknown` distinct from
  `missing` for the reason `preflight.ts` states, and each `unknown` NAMES its cause (no `kubectl`,
  an unreachable apiserver, a refused read, an unparseable answer, a filtered port) because each
  needs a different thing done. The summary and the deep link key off the verdict; an unestablished
  ingress WITHHOLDS the `hostTemplate` prefill, so the connect form's required field stays empty
  rather than saving a URL nothing serves, and `buildK3sHandler` answers `null` rather than
  fabricating a `url` block for a `--register` to POST.
- **The port half is settled against the CONTAINER RUNTIME, not a socket.** A TCP connect proves
  something listens, and an unrelated web server on host 80 answers it exactly as an ingress
  controller does, so a cluster forwarding nothing could read as ready. Where the CLI can name the
  cluster (every create/recreate, plus a reuse whose context resolves to a detected k3d/kind
  cluster) it reads `docker port` on the cluster's own container: that both refutes a foreign
  listener and names the host port the cluster DOES publish, which is a shorter fix than a rebuild.
  Where it cannot be asked, the verdict stays `ready` with `attribution: 'unattributed'` and the
  summary says which half was not checked.
- **The deep-link contract gains `scheme`** (Decision 4's param list) and `ingressPort`: a local
  ingress controller's TLS is self-signed, so the verified derivation is plain HTTP, and a
  non-default host port rides its OWN param. It cannot ride inside the host template, because the
  rendered template is also the Ingress `spec.rules[].host` a service's manifests declare and
  Kubernetes rejects a `host` carrying a port. That is why the `ingressTemplate` URL source gained
  an optional `port` in `@cat-factory/contracts` (additively, on `/api/v1` too).
- **`--recreate`** destroys and rebuilds a named k3d/kind cluster from the current flags, since a
  published host port cannot be added in place. It is a GENERAL operation (these clusters are
  transient), not one condition's remedy: it is offered whenever the CLI can both name the cluster
  and build it again, never for `use-existing`, and it is deliberately absent from the
  recommendation priority so `--yes` alone can never select a destructive path. The recreate set is
  ONE table (`RECREATE_OFFERS`, keyed by runtime) rather than a ternary, so `--runtime k3s` is
  refused outright instead of resolving to the k3d branch and destroying a cluster nobody named:
  `K3sRuntime` has three members and only two of them name a cluster this CLI can rebuild.
- **A remedy that names a recreate is one the CLI would ACCEPT.** The missing-host-port fix is
  rendered from the resolved target (`ResolvedConnection.recreateTarget`), and where there is none
  it says so instead of printing a `cat-factory k3s --recreate` that `chooseOffer` then refuses
  against the default cluster name.

## References

- Operator/end-to-end runbook: [`../local-k3s-environments.md`](../local-k3s-environments.md)
  (guided + manual) and [`../local-kubernetes-setup-windows.md`](../local-kubernetes-setup-windows.md).
- Builds on ADR 0007 (per-service provisioning: the `local-k3s` engine + handler-test probe) and
  ADR 0003 (pluggable ephemeral-environment providers).
- This ADR supersedes the initiative tracker that drove the 6-slice delivery (removed once
  complete; slice history is in the git log: PRs #557, #569, #578, #585, and the slice-4/5 PR
  this ADR lands with).
