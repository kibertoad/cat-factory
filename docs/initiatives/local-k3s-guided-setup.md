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

The PR that seeded this initiative (#557) closed the *feedback* gap — selecting `local-k3s`
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
2. **Offer** — a small set of selections: *use the existing cluster*, *create a k3d cluster*
   (Docker, no root — the recommended default), or *show me the k3s install command* (needs
   sudo — guided, not silently run).
3. **Provision** (explicit confirm per action) — run the chosen setup, then create the
   ServiceAccount + minimal RoleBinding and `kubectl create token`.
4. **Wire + verify** — write the `kubernetes` handler (apiserver URL from kubeconfig +
   skip-TLS for the loopback self-signed cert + the minted token) and run the
   `environments/handlers/test` probe; surface a green/red result.

## Key decision — where the guided flow lives (RESOLVE BEFORE SLICE 1)

The orchestrator backend is a non-interactive HTTP server (no TTY), so the interactive part
cannot be a bare endpoint that "prompts". Two viable homes; **pick one before building**:

- **(Recommended) the CLI (`@cat-factory/cli`)** — already interactive (`@clack/prompts`) with
  an injectable IO + FS seam and a tested pure-function core (`buildPlan`/`generateSecrets`/…).
  It is also the right place for **privileged host setup** (an install that needs sudo). A new
  `cat-factory k3s` (or `cat-factory infra`) subcommand: probe → prompt → run → write the
  handler (or emit the values for the user to save). The SPA's `Local k3s` hint deep-links to it.
- **an in-app SPA wizard** — a multi-step modal calling **new local-mode-only** backend
  endpoints (`POST …/infra/k3s/probe`, `POST …/infra/k3s/provision`) that shell out on the host.
  Closest to the "few prompts/selections" phrasing and keeps the user in one surface, but adds a
  privileged host-shell capability to the HTTP layer (see safety gotcha) and can't do a sudo
  install without elevation.

Recommendation: **CLI** for the privileged provisioning, with the SPA wizard (optional,
later) only orchestrating the non-privileged k3d path + the handler write. This doc plans the
CLI-first shape; revisit if the requester prefers the in-app wizard.

## Conventions & gotchas (carried between slices)

- **Local mode ONLY — hard-gated.** Shelling out to install/configure a cluster is a new,
  powerful capability. It must be reachable only on the local facade (the same gate the per-user
  override + `LOCAL_CONTAINER_RUNTIME` use), never wired off-local, and **every** mutating step
  (install, cluster create, token mint) requires an explicit user confirmation. No silent
  privileged shell-out.
- **k3d-via-Docker is the low-friction default** (no root; Docker is already a local-mode
  prerequisite for agent containers). `curl | sh` k3s install needs sudo → *guide* it (print the
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

### Slice 1 — decide the surface + pure probe planner (todo)

- Resolve the **CLI vs SPA-wizard** decision above with the requester.
- Pure, testable **probe planner**: given the outputs of `kubectl`/`k3d`/`kind`/`docker`
  detection (injected), classify the host state (reachable cluster / startable cluster /
  installable / nothing) and produce the offered options. No shell-out in the pure layer.
- A thin **host shell-out IO seam** (mirroring the CLI's IO seam + `ContainerRuntimeAdapter`),
  with the real impl spawning the CLIs and a fake for tests.

### Slice 2 — provision actions (k3d default) (todo)

- k3d cluster create (Docker, no root); kubeconfig read for the apiserver URL.
- ServiceAccount + least-privilege RoleBinding + `kubectl create token` (k8s 1.24+),
  idempotent (reuse if present).
- Each action behind an explicit confirm; the k3s `curl | sh` path is *guided* (printed /
  elevated-confirm), not auto-run.

### Slice 3 — wire + verify (todo)

- Write the `kubernetes` infra handler from the resolved values (apiserver URL + skip-TLS +
  minted token) via the existing register path (CLI: write `.env`/call the API; wizard: call
  `registerHandler`).
- Run the `environments/handlers/test` probe and report the result; on failure, surface the
  apiserver's message (the probe already does this).

### Slice 4 — docs + escape hatch (todo)

- Point `local-k3s-environments.md` / `local-kubernetes-setup-windows.md` at the new command,
  keeping the manual steps as the advanced path. Surface the command from the SPA's `Local k3s`
  hint.

---

## Per-item status

| Item | Status | PR |
| --- | --- | --- |
| Slice 0 — prefill + hint + handler test-connection probe | done | #557 |
| Decide surface (CLI vs in-app wizard) | todo | — |
| Slice 1 — pure probe planner + host shell-out seam | todo | — |
| Slice 2 — provision actions (k3d default; guided k3s) | todo | — |
| Slice 3 — wire handler + verify via existing probe | todo | — |
| Slice 4 — docs + SPA deep-link + escape hatch | todo | — |
