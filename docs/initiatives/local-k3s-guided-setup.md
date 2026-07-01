# Local k3s guided setup (probe + provision on the user's behalf)

> Initiative tracker + plan of record. A later iteration reads this FIRST to resume
> without re-deriving context. This is the durable plan; capture every decision here.

## Goal & rationale

In **local mode** a developer who wants the Tester to provision ephemeral environments on a
local Kubernetes cluster must, today, do everything by hand: install/start a cluster (k3s /
k3d / kind), create a ServiceAccount + RoleBinding, mint a token, find the apiserver URL, and
paste all of it into the Kubernetes engine form (Settings → Infrastructure → Kubernetes →
`Local k3s`). That is a lot of out-of-band `kubectl`/install ceremony for a "just run it
locally" product, and every step is a place to get a value subtly wrong.

The PR that seeded this initiative (#557) closed the _feedback_ gap — selecting `local-k3s`
now prefills loopback defaults, explains how to mint a token, and offers a **Test connection**
button — but the user still runs every command themselves.

**Target end state:** in local mode, cat-factory can **probe** the host for a usable cluster
and, with a few confirmations, **provision one and wire the handler on the user's behalf** —
create (or reuse) a local cluster, create the ServiceAccount + RoleBinding, mint a token, read
the apiserver URL from the kubeconfig, write the `kubernetes` infra handler, and verify it with
the existing connectivity probe. The manual form stays as the escape hatch / advanced path.

Concretely, a guided flow:

1. **Probe** — detect what already exists: a reachable cluster via the current kubeconfig
   (`kubectl version`/`~/.kube/config`), a running k3d/kind cluster (via Docker), or installed
   CLIs (`k3d`, `kind`, `k3s`, `kubectl`). Report what was found + what's missing.
2. **Offer** — a small set of selections: _use the existing cluster_, _create a k3d cluster_
   (Docker, no root — the recommended default), or _show me the k3s install command_ (needs
   sudo — guided, not silently run).
3. **Provision** (explicit confirm per action) — run the chosen setup, then create the
   ServiceAccount + minimal RoleBinding and `kubectl create token`.
4. **Wire + verify** — write the `kubernetes` handler (apiserver URL from kubeconfig +
   skip-TLS for the loopback self-signed cert + the minted token) and run the
   `environments/handlers/test` probe; surface a green/red result.

## Key decision — where the guided flow lives (RESOLVED: hybrid, CLI-primary)

The orchestrator backend is a non-interactive HTTP server (no TTY), so the interactive part
cannot be a bare endpoint that "prompts". Two homes were on the table:

- **the CLI (`@cat-factory/cli`)** — already interactive (`@clack/prompts`) with an injectable
  IO + FS seam and a tested pure-function core (`buildPlan`/`generateSecrets`/…). It is also the
  right place for **privileged host setup** (an install that needs sudo). A new `cat-factory k3s`
  (or `cat-factory infra`) subcommand: probe → prompt → run → write the handler (or emit the
  values for the user to save). The SPA's `Local k3s` hint deep-links to it.
- **an in-app SPA wizard** — a multi-step modal calling **new local-mode-only** backend
  endpoints (`POST …/infra/k3s/probe`, `POST …/infra/k3s/provision`) that shell out on the host.
  Closest to the "few prompts/selections" phrasing and keeps the user in one surface, but adds a
  privileged host-shell capability to the HTTP layer (see safety gotcha) and can't do a sudo
  install without elevation.

**Decision (hybrid, CLI-primary):**

- **The CLI owns all privileged host work.** `cat-factory k3s` does the probe → provision →
  token-mint. Shelling out to install/configure a cluster (and any `sudo` k3s install) does NOT
  belong in the non-interactive HTTP layer; the CLI already has the interactive IO+FS seam and is
  the natural home for privileged setup. The wizard-driving-backend-shell-out option is explicitly
  **not** taken — it would push a privileged host-shell capability into the server and still
  couldn't `sudo`.
- **The SPA covers the UI angle via a deep-linked guided entry point**, not a host-shelling
  backend. The `Local k3s` hint gains an "Auto-setup with the CLI" affordance that surfaces the
  command and accepts the CLI's deep-link to **pre-fill the existing engine form**; the user then
  runs the #557 **Test → Save** unchanged. A full in-app wizard for the non-privileged k3d path
  stays optional/later.
- **Handler sink = emit values + deep-link the SPA form** (slice 1). After provisioning, the CLI
  prints the resolved connection values and opens the pre-filled `local-k3s` form, reusing
  `testHandler` + `registerHandler` as-is — so the CLI needs no local-mode auth or workspace-id
  knowledge. A hands-free `--register` flag (CLI POSTs to the local API) is a clean follow-up,
  not slice 1.

## Conventions & gotchas (carried between slices)

- **Local mode ONLY — hard-gated.** Shelling out to install/configure a cluster is a new,
  powerful capability. It must be reachable only on the local facade (the same gate the per-user
  override + `LOCAL_CONTAINER_RUNTIME` use), never wired off-local, and **every** mutating step
  (install, cluster create, token mint) requires an explicit user confirmation. No silent
  privileged shell-out.
- **k3d-via-Docker is the low-friction default** (no root; Docker is already a local-mode
  prerequisite for agent containers). `curl | sh` k3s install needs sudo → _guide_ it (print the
  command / require an explicit elevated confirm), don't run it unprompted.
- **Reuse, don't reinvent, the host shell-out seam.** `ContainerRuntimeAdapter`
  (`runtimes/local/src/runtimes/*`) already detects + drives docker/podman/orbstack/colima/apple
  and `NativeCliDeployTransport` already shells out to native CLIs — mirror their adapter shape +
  command-not-found handling rather than spawning ad-hoc.
- **k3s / k3d / kind are one preset.** They expose a loopback apiserver with a self-signed cert
  and the same SA-token flow; only the port differs (read it from the kubeconfig). Do NOT add
  per-distro handler shapes — write the same `kubernetes` engine config, varying only the URL.
- **Verify with the existing probe.** After wiring, call `EnvironmentConnectionService.testHandler`
  (the `environments/handlers/test` endpoint from #557) — don't add a second connectivity check.
- **Least-privilege RBAC.** The created ServiceAccount needs only what the kube env backend
  uses (namespaces + the per-PR resources it applies). Start from a namespaced Role where
  possible; document any cluster-scoped grant. Never bind `cluster-admin` by default.
- **Idempotent + re-runnable.** Re-running the flow against an already-set-up cluster should
  detect + reuse (probe first), not duplicate the SA or recreate the cluster.
- **No secret leakage.** The minted token is written only into the handler's encrypted secret
  bundle (and, for the CLI, the gitignored `.env` if that's the chosen sink) — never logged.

## Target pattern (reference implementations to mirror)

- **#557** — the landed foundation: the `local-k3s` prefill + hint + the
  `POST /workspaces/:ws/environments/handlers/test` probe (`EnvironmentConnectionService.testHandler`).
  The guided flow's final "verify" step calls this; its "wire" step writes the same handler the
  form's `saveKube` does (`infra.registerHandler`).
- **`@cat-factory/cli`** (`cat-factory init`) — the interactive-flow template: pure
  `buildPlan`/`generateSecrets`/`buildLocalEnv` under an injectable IO+FS seam, `@clack/prompts`
  confined to the real IO impl, fully unit-tested. Add the probe/provision logic the same way
  (pure planners + a thin shell-out IO seam) so it's testable without a real cluster.
- **`ContainerRuntimeAdapter`** (`runtimes/local/src/runtimes/*`) + **`NativeCliDeployTransport`**
  — the host CLI-detection + shell-out pattern (runtime selection, `--version` probes,
  command-not-found → actionable error).
- **`backend/docs/local-k3s-environments.md`** + **`local-kubernetes-setup-windows.md`** — the
  manual runbook the automation encodes; keep them in sync (or point them at the new command).

---

## Implementation plan (per slice)

### Slice 0 — foundation (DONE, PR #557)

- `local-k3s` engine selection prefills loopback defaults + shows the token-minting hint
  (`KubernetesEngineForm.vue`); switching to `remote-kubernetes` clears the local-only defaults.
- `POST /workspaces/:ws/environments/handlers/test` (`testEnvironmentHandlerContract` →
  `EnvironmentConnectionService.testHandler`) probes the apiserver with the supplied token; wired
  into the engine form (workspace + per-user override). This is the verify step the guided flow reuses.

### Slice 1 — CLI surface + pure probe planner + shell-out seam (DONE, PR #569)

New files under `backend/packages/cli/src/`, mirroring the `init` structure (pure planners +
injectable IO/FS seam, `@clack/prompts` confined to the real IO impl):

- **`k3s.ts`** — orchestrator `setupK3s(options, deps)` taking `{ io, fs, shell, cwd }` (defaults
  applied). Drives probe → offer → provision → hand-off. Never imports `@clack/prompts`.
- **`k3s-probe.ts`** (pure) — `classifyHost(detections): HostState`, where `detections` is the
  injected output of `kubectl version` / `k3d cluster list` / `kind get clusters` / `docker info`
  / CLI `--version` checks. Produces `{ reachableCluster?, dockerAvailable, installed:
{k3d,kind,k3s,kubectl}, offers: Offer[] }`. Offers: _use existing cluster_, _create k3d cluster_
  (default), _show k3s install command_. No shell-out in the pure layer.
- **`host-shell.ts`** — the `HostShell` seam: `run(cmd, args): Promise<{code, stdout, stderr}>` +
  `which(bin)`. Real impl spawns via `child_process`; a `scriptShell` fake for tests (mirrors
  `scriptIo`/`memFs`). Command-not-found → actionable error, mirroring `ContainerRuntimeAdapter`
  (`runtimes/local/src/runtimes/containerRuntime.ts`) + `LocalProcessRunnerTransport`.
- Wire `src/args.ts` (`CliOptions.command` gains `'k3s'`; flags `--cluster-name`, `--runtime`,
  `--no-open`, `--yes`) + `src/bin.ts` dispatch + a `HELP_TEXT` entry.
- Tests: `k3s-probe.test.ts` (classification over injected detection fixtures); `k3s.test.ts`
  (orchestrator over `scriptIo`/`memFs`/`scriptShell`, no real cluster).

### Slice 2 — provision actions (k3d default; guided k3s) (DONE, PR #578)

- **`k3s-provision.ts`** (pure planners + a thin executor over `HostShell`):
  - k3d/kind: plan `k3d cluster create <name> --api-port 6443` (or `kind create cluster --name`)
    under a 5-minute create watchdog (`CLUSTER_CREATE_TIMEOUT_MS` — the default 10s would SIGKILL
    the node-image pull), then read the apiserver URL from the created context via an explicit
    `--context k3d-<name>` / `--context kind-<name>` (`kubectl config view --minify …
{.clusters[0].cluster.server}`) rather than mutating the user's global current-context. A
    `0.0.0.0` bind address is normalized to `127.0.0.1`; a create that fails on the apiserver port
    surfaces a collision hint. (Local-image `k3d image import` wiring noted for the future
    managed-lifecycle work.)
  - SA + **reduced-privilege** RBAC + token: `kubectl apply -f -` the `RBAC_MANIFEST` (namespace +
    ServiceAccount + a scoped `ClusterRole`/binding over the env backend's manifest kinds +
    `namespaces` create/delete + `pods`/`pods/proxy` for the runner — **NOT `cluster-admin`**) plus
    a long-lived `kubernetes.io/service-account-token` Secret (k8s ≥ 1.24 no longer auto-creates
    one), then read + base64-decode that Secret's token (retrying while the token controller
    populates it). Chosen over a short-lived `kubectl create token` so the wired handler doesn't
    silently expire. Credential-bearing kinds (`secrets`, `serviceaccounts`) are granted WITHOUT
    cluster-wide `list`/`watch` — that would let the token enumerate/read every Secret (hence every
    other SA token), which on a single-node cluster is effectively cluster-admin; only single-object
    create/get/patch/delete is granted.
  - **Idempotent**: probe-first; an existing cluster is reused (no create) and `kubectl apply`
    reconciles the SA/RBAC rather than duplicating.
  - Each mutating step (cluster create, RBAC apply) is behind an **explicit confirm** that names the
    target context + apiserver (skipped only by `--yes`); the `install-k3s` `curl | sh` path is
    still guidance-only — the command is PRINTED, never run. In `--yes` mode the `use-existing` path
    **refuses** to provision a reachable cluster that doesn't look local (a local-looking context
    name or a loopback/Docker-host apiserver), so a kubeconfig pointed at a shared/remote cluster
    isn't silently mutated non-interactively.
- **stdin seam**: `HostShell.run` gained an `input?` option so the manifest (and the token Secret it
  mints) is piped to `kubectl apply -f -` WITHOUT ever hitting a temp file on disk.
- The pure layer returns the individual command specs + the rendered manifest; the executor
  (`provisionCluster`) runs them through `HostShell`, captures the minted token, and returns a
  `ResolvedConnection { engine:'local-k3s', apiServerUrl, apiToken, insecureSkipTlsVerify, clusterName? }`.
  The token is surfaced only to the user (printed once, to paste into the form) — never written to
  disk/logs by cat-factory. Slice 3 turns the `ResolvedConnection` into the handler + deep-link.

### Slice 3 — wire + verify (DONE, this PR)

- **`k3s-handler.ts`** (pure) — `buildK3sHandler(resolved): K3sHandlerInput` producing
  `{ provisionType: 'kubernetes', config: { engine: 'local-k3s', kubernetes: { label, apiServerUrl,
insecureSkipTlsVerify: true, namespaceTemplate: 'cf-env-{{pullNumber}}', url: { source:
'ingressTemplate', hostTemplate: '{{branch}}.127.0.0.1.nip.io' } } }, secrets: { apiToken } }`.
  The handler shape is **mirrored structurally in the CLI** (not imported) so the package keeps its
  single `@clack/prompts` runtime dep; `@cat-factory/contracts` is a **devDependency** only, and
  `k3s-handler.test.ts` parses a built value through the real `registerEnvironmentHandlerSchema` so
  any drift from the contract fails a test. The minted token rides ONLY in the write-only `secrets`
  bundle — asserted never to appear in the config or the deep-link.
- **`buildK3sSetupUrl(spaBaseUrl, handler)`** (pure) — the deep-link that opens the SPA's Local k3s
  connect form pre-filled with the **non-secret** fields (`infraSetup=local-k3s`, `label`,
  `apiServerUrl`, `namespaceTemplate`, `hostTemplate`, `insecureSkipTlsVerify`). The token is
  deliberately omitted (a secret in a URL leaks into history/logs); the user pastes it (printed once
  to the terminal) then runs Test → Save. Param names mirror the form fields; **slice 4 teaches the
  SPA to read them**.
- **Hand-off wiring (`k3s.ts` `handOff`)** — after `printConnectionSummary`, print the deep-link and
  open it in the browser, EXCEPT under `--no-open` or non-interactive `--yes` (automation). New
  `--app-url` flag (default `http://localhost:3000`, the local-mode SPA URL) + help text.
- **Verify** is unchanged: the user runs **Test → Save**, reusing
  `EnvironmentConnectionService.testHandler` (the `POST /workspaces/:ws/environments/handlers/test`
  probe from #557) + `registerHandler`. No new backend endpoint. On failure the probe already
  surfaces the apiserver's message.
- The hands-free **`--register`** flag (CLI POSTs the handler to the local API directly) is
  documented in the k3s help text as a planned follow-up, not implemented here.

### Slice 4 — SPA guided entry point + deep-link (todo)

- Extend the `local-k3s` hint in `KubernetesEngineForm.vue` / `InfraHandlersConfigurator.vue` with
  an **"Auto-setup with the CLI"** affordance: shows the `cat-factory k3s` command and accepts the
  CLI's deep-link to pre-fill the form (URL param → prefill → Test/Save). All copy through i18n
  under `settings.infrastructure.kubernetesEngine.*`; add keys to `i18n/locales/en.json` only.
- **Deep-link contract (established in slice 3, `buildK3sSetupUrl`):** the CLI opens the SPA base
  URL with query params `infraSetup=local-k3s` (the trigger + engine), `label`, `apiServerUrl`,
  `namespaceTemplate`, `hostTemplate`, and `insecureSkipTlsVerify=1` — param names mirror the
  connect-form fields. The ServiceAccount **token is NOT in the URL** (secret): the SPA prefills
  everything else and leaves the user to paste the token, then Test → Save. On load, read
  `route.query.infraSetup === 'local-k3s'` → open the InfrastructureWindow + Kubernetes engine form
  seeded from the params.
- (Optional, later) a full in-app wizard modal mirroring `BootstrapModal.vue` for the
  _non-privileged_ k3d path — deferred; the deep-link covers the UI angle for the first cut.

### Slice 5 — docs + escape hatch (todo)

- Point `local-k3s-environments.md` / `local-kubernetes-setup-windows.md` at the new command,
  keeping the manual steps as the advanced path. Surface the command from the SPA's `Local k3s`
  hint. Update the status table below + link the landed PR as the reference implementation.

---

## Per-item status

| Item                                                        | Status   | PR   |
| ----------------------------------------------------------- | -------- | ---- |
| Slice 0 — prefill + hint + handler test-connection probe    | done     | #557 |
| Decide surface (CLI vs in-app wizard)                       | resolved | —    |
| Slice 1 — CLI surface + pure probe planner + shell-out seam | done     | #569 |
| Slice 2 — provision actions (k3d default; guided k3s)       | done     | #578 |
| Slice 3 — wire handler (build + hand-off) + verify probe    | done     | this |
| Slice 4 — SPA guided entry point + deep-link                | todo     | —    |
| Slice 5 — docs + escape hatch + tracker update              | todo     | —    |
