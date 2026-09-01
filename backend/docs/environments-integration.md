# Ephemeral environment provider integration

> **Setting one up is on the website**:
> [Environments](https://www.catfactory.ai/operate/environments.html) owns configuring and
> operating ephemeral environments, and
> [Custom Providers](https://www.catfactory.ai/extend/custom-providers.html) owns writing a code
> adapter, with the shared manifest concepts on
> [Integration manifests](https://www.catfactory.ai/extend/manifests.html). This page is the
> provider-integration DESIGN.

Let a workspace plug in its **own** ephemeral/preview-environment tooling so a
`deployer` agent can provision an environment and a `tester` agent can run against
it. The integration is declarative and **API-only**: you describe your self-rolled
management API as an HTTP manifest; there are no provider presets and no code to
write. It assembles wherever the shared encryption key is set (the same "always on
where the key is present" model as documents/tasks); nothing provisions until a
workspace registers a connection and its pipeline runs a `deployer`/`tester` step.

This is the **sibling** of the [self-hosted runner pool](./runner-pool-integration.md):
same manifest machinery (auth schemes, `{{var}}` templating, dot-path response
mapping, SSRF guard, at-rest encryption), but it provisions a **preview deployment to
test against** rather than a **runner to execute agents on**. The work splits the same
way: a **Platform/Infra team** stands up the management API in front of your
environment tooling (k8s namespaces, a Vercel-style service, an internal provisioner);
an **Application team** writes the manifest and registers it per workspace.

See also [ADR 0003](./adr/0003-ephemeral-environment-provider.md). When your tooling is too
bespoke to describe declaratively, you can instead inject a hand-written **native adapter**:
see [Native environment adapters](./native-environment-adapter.md).

> **A manifest is the last resort, not the first.** Four backends ship in the box and need none:
> `kubernetes`, `eks`, `cloudflare` and `compose` (the `docker-compose` provision type, over the
> `local-docker` engine); choosing between them is the site's
> [Choosing a backend](https://www.catfactory.ai/operate/environments.html#choosing-a-backend).
> What belongs here is why the two ends of that list are offered on different facades, which is a
> property of what each one has to reach rather than a packaging decision:
>
> - **`cloudflare` is available everywhere**, the Cloudflare Worker facade with no Docker daemon
>   and no filesystem included, because it stands its per-PR Worker up by driving the target
>   repository's OWN preview workflow over the VCS Deployments API: outbound HTTPS is the whole
>   requirement. Its reference workflow lives in
>   [`deploy/preview`](../../deploy/preview/README.md); wiring it to a board is
>   [`docs/internal/dogfooding.md`](../../docs/internal/dogfooding.md).
> - **`compose` is the local facade's alone**, and only when `LOCAL_CONTAINER_RUNTIME` selects a
>   Docker-family runtime, because it drives a host `docker compose` binary. It is therefore the
>   one built-in the facade registers BY REFERENCE (closing over the host CLI seam) instead of
>   building from config, and the one that rides the contract's generic backend-manifest member
>   rather than a reserved kind.

> **The connection is now per provision type, not one per workspace.** This doc describes the
> generic HTTP `manifest` backend, which today serves the **`custom` provision type** via the
> `remote-custom` engine. The single per-workspace `environment_connections` row has been
> reshaped into per-provision-type **handlers** (keyed by `(workspace_id, provision_type,
manifest_id)`), and a service selects its type/source independently of the workspace's
> handler. A `kubernetes` service additionally has a native render/deploy path (raw apiserver
> apply, or kustomize/helm/Gateway via a deploy container). See
> [per-service-provisioning.md](./per-service-provisioning.md) for the full model, the engines,
> and the per-type / custom-type / detect endpoints. The legacy
> `/workspaces/:ws/environments/connection` endpoints below remain as the compat bridge.

## How it works (the sequence of actions)

The shape a user sees (a deployer provisions, a tester runs against the preview, the environment
goes away) is the site's
[How it works](https://www.catfactory.ai/operate/environments.html#how-it-works). What that page
does not say, and a change on this path has to hold:

1. The **`deployer`** step calls `HttpEnvironmentProvider.provision`, interpolating the manifest's
   `provision` template with `{{input.*}}` derived from the block. It runs **deterministically**:
   no LLM, no token spend, so a provisioning failure is never a model's fault.
2. An async `provision` (the normal case: the create call returns with the environment still
   building) does NOT complete the step. The deployer parks on a readiness wait and re-reads the
   `status` template between driver polls until the mapped status reaches `ready`, reaches a state
   it will never leave, or crosses `ENVIRONMENT_READY_TIMEOUT_MS` (kernel,
   `domain/environment-readiness.logic.ts`). Only `ready` is recorded as the frame's outcome; the
   handle's URL and access creds come off the `response` dot-paths, not off any fixed response
   shape. The TTL sweep below reclaims environments, it does not reconcile their status: nothing
   else polls a provisioning environment, which is why the wait lives on the step that made it.
   **What that wait can SAY is `statusNote`**, persisted from every poll whatever the status, where
   `lastError` is written on `failed` alone: it is the only channel a `provisioning` provider has,
   and without it the 20-minute ceiling could report nothing but its own duration. A code adapter
   sets it ([`native-environment-adapter.md`](./native-environment-adapter.md#saying-why-an-environment-is-not-ready-yet-statusnote));
   the generic manifest path maps no error or note, so a manifest-authored provider keeps today's
   behaviour exactly.
3. The tester job's `test.environmentUrl` is wired straight from the persisted handle, so nothing
   downstream re-derives the address the environment was actually reached at. A step whose run mode
   IS the ephemeral environment (`runsAgainstEphemeralEnvironment`, the predicate its own prompt
   branches on) and that has no URL is REFUSED at dispatch rather than sent a `(pending)` address
   (`environmentDispatch.logic.ts`): the readiness wait normally makes that unreachable, and this
   covers what a wait cannot (an environment that expired mid-run, a chain with no `deployer`).
4. The sweep (every 2 min) tears down at the handle's TTL, taken from `expiresAtPath` or falling
   back to `defaultTtlMs`, and tombstones the record. Teardown is best-effort and retried on the
   next pass rather than wedging the registry, and a teardown call returning cleanly is not a
   reclaim: see [Confirming a teardown](#confirming-a-teardown-confirmteardown).

## Enabling it

There is nothing to turn on. The module assembles wherever the service-level encryption key is set,
which is already required service-wide (the always-on document/task sources fail config load
without it), and per-tenant credentials have no plaintext fallback. Setting the key is the site's
[configuration page](https://www.catfactory.ai/deploy/configuration.html); the variable itself is
`ENCRYPTION_KEY` in [`environment-variables.md`](../../docs/environment-variables.md).

That master key encrypts, at rest, both the per-tenant provider credentials and each provisioned
environment's own access credentials: AES-256-GCM, per-record salt + IV, HKDF-derived key, and a
versioned `v1.…` envelope so a rotation can tell the generations apart.

## The manifest

> **The manifest FORMAT is the website's**:
> [Integration Manifests](https://www.catfactory.ai/extend/manifests.html#environment-provider-manifest)
> owns the field schema, the `{{input.*}}` / `{{provision.*}}` namespaces including the git/PR/repo
> context table, the auth-scheme table, the worked PR-environment example, and the two things to
> check against a real platform's API (where the URL lives, and asynchronous provisioning). A
> manifest is authored in the app by a user with no checkout, so none of it is here.

The single generic `HttpEnvironmentProvider` interprets it and nothing about your endpoints is
assumed. Four facts about that interpretation belong to this repository:

- **The schema is Valibot, in `backend/packages/contracts/src/environments.ts`**, enforced at
  registration. A field added there is a field the website page has to gain, in the same change.
- **`{{input.*}}` on a `deployer` step is DERIVED, and the derivation is the engine's.** The block
  supplies `blockId` / `title` / `type` / `description` / `features`; the git/PR/repo half is read
  off the block's open pull request, so it is present only when there is one. An explicit request
  input always wins over a derived value, which is what makes a manual provision able to stand in
  for a missing PR rather than being a second code path.
- **A dot-path that cannot address the value is the boundary of this integration**, not a gap to
  widen. The response mapping is deliberately a set of dot-paths rather than an expression
  language: a platform whose URL is only reachable through a computed structure has outgrown the
  manifest, and the answer is the code-adapter seam below.
- **`addressesPath` is a CLAIM the platform then proves**, and the proving is the part that lives
  here. What an author writes is the website's
  ([Addresses](https://www.catfactory.ai/extend/manifests.html#addresses-the-half-a-url-cannot-express));
  what this repo owns is which addresses are dialled at all (kernel's `isBridgeableAddress`, at
  PLAN time, so a provider-authored list cannot aim the platform's own socket at loopback or a
  metadata endpoint), what the verdict may be (`EnvironmentRouteProof`, whose `inconclusive` state
  never fails a frame), and how the address reaches a container. Design:
  [ADR 0062](./adr/0062-environment-address-bridge-and-route-proof.md).
  **A field present on the response mapping is present only when the manifest DECLARES it**, empty
  list included, because "the provider stated none" and "this response said nothing" are different
  facts and conflating them erases a stored candidate list on the first status poll.

### Auth schemes (calling the management API)

The scheme table is the website's too, and it is shared with the runner pool: both integrations
accept the same six types, which is why the page states them once. What is worth knowing HERE is
that the two integrations resolve their URL policies independently (see
[Reaching an internal / VPN-hosted platform](#reaching-an-internal--vpn-hosted-platform)), so the
schemes are shared and the network policy is not.

## Code-adapter seam (when the manifest isn't enough)

A single `fetch` plus dot-path mapping cannot express everything: a platform that paginates, needs
a multi-step handshake, returns the env URL inside a structure no dot-path can address, signs
requests in a bespoke way, or wants the typed git/PR/repo context as real fields rather than
interpolated strings. For those a **trusted, operator-installed** code adapter replaces the
generic HTTP provider.

Deciding between the two is the site's
[When the manifest isn't enough](https://www.catfactory.ai/operate/environments.html#when-the-manifest-isn-t-enough),
and **[`native-environment-adapter.md`](./native-environment-adapter.md) is the full contract for
writing one**: the `EnvironmentProvider` port and its optional connect-form methods, the typed
`provisionContext`, `confirmTeardown`, registering an `EnvironmentBackendProvider` by reference
into the app-owned registry (including the `engines` a custom backend must declare to be reachable
at all), the single-tenant-versus-multi-tenant rationale, and the SSRF rule for a URL read out of
`providerConfig`. None of it is restated here.

What belongs to THIS doc is how a code adapter sits inside the manifest integration:

- **Everything around the provider is unchanged.** The connection registry, secret encryption, TTL
  sweep and agent-context surfacing all still apply, so an adapter still registers a connection
  (which is what encrypts its secrets at rest and assembles the module). Its `manifest`'s request
  templates are ignored in favour of your code, while `secrets`, `providerId` and `label` still
  apply.
- **The URL it returns is still SSRF-guarded**, because the guard belongs to the engine rather than
  to the provider that produced the URL. Installing your own code is therefore not a way around it;
  reaching an internal platform means widening the URL policy
  ([below](#reaching-an-internal--vpn-hosted-platform)).

### Confirming a teardown (`confirmTeardown`)

`teardown()` returning without throwing does **not** mean anything was destroyed: this integration's
generic provider reports `torn_down` even when its manifest declares no `teardown:` request, and an
asynchronous delete (a Kubernetes namespace) is accepted while the resource is still terminating. So
no teardown path reads a teardown call's success as the environment's death. It asks separately,
through the optional `confirmTeardown` probe, and only a probe that positively finds the resource
gone is recorded as a reclaim. Writing one is in
[`native-environment-adapter.md`](./native-environment-adapter.md); why the seam exists, what the
verdicts mean and which paths record them is
[`environment-disposal-and-teardown-proof.md`](../../docs/initiatives/environment-disposal-and-teardown-proof.md).

## Reaching an internal / VPN-hosted platform

Setting the allow-list is the site's
[Reaching an internal provider](https://www.catfactory.ai/operate/environments.html#reaching-an-internal-provider),
and the two variables are `ENVIRONMENTS_ALLOW_URL_HOSTS` / `ENVIRONMENTS_ALLOW_HTTP_URLS` in
[`environment-variables.md`](../../docs/environment-variables.md). Three facts about the guard
itself are the doc-side half:

- **It covers three surfaces, not one**: the manifest `baseUrl`, the OAuth `tokenUrl`, and the env
  URL extracted from your response. A widening reaches all three, so a host allowed to be called is
  also a host a tester can be sent at.
- **It is a facade-level setting, deliberately not a per-workspace one.** Widening is a trusted
  operator's decision about the deployment's network position; letting a workspace name its own
  exempt hosts would make the SSRF guard self-service.
- **The policy is resolved per integration**, so a host allowed here is not thereby reachable by
  the runner pool's matching `RUNNERS_*` knobs, or vice versa. Each resolves its own policy from
  its own settings, and that separation is the point rather than an oversight.

## Registering a provider

Registration, secret rotation and connection testing happen in-app, through the Infrastructure
window's manifest editor: the site's
[Registering an HTTP manifest provider](https://www.catfactory.ai/operate/environments.html#registering-an-http-manifest-provider).
The editor drives the same endpoints, whose contract is that a secret VALUE goes in and never comes
back out:

- `POST /workspaces/:ws/environments/connection` → manifest plus a value for every `secretRef.key`
  it references; the values are encrypted at rest and never returned.
- `GET /workspaces/:ws/environments/connection` → safe metadata plus `secretKeys` (names only).
- `PUT /workspaces/:ws/environments/connection/secrets` → rotate the secret bundle.
- `DELETE /workspaces/:ws/environments/connection` → unregister.

## Provisioning & discovery

The intended flow is a pipeline on an `environment` block with agent kinds
`["deployer", "tester"]`, following the sequence in
[How it works](#how-it-works-the-sequence-of-actions) above. You can also drive it
directly over REST:

- `POST /workspaces/:ws/environments/provision` `{ blockId?, inputs? }` → handle
- `GET  /workspaces/:ws/environments` → handles (no credentials)
- `GET  /workspaces/:ws/environments/:id` → one handle (no credentials)
- `GET  /workspaces/:ws/environments/:id/access` → the **decrypted** access creds
  (the only endpoint that returns them; over TLS)
- `POST /workspaces/:ws/environments/:id/teardown` → tear down now

## Security notes

- **Encryption at rest.** The per-tenant secret bundle and every env's access creds
  are AES-256-GCM ciphertext in D1; only the service-level master key lives in env.
- **No secret leakage.** Secrets are placed only in outgoing request headers, never
  in logs, error bodies (which are length-capped and carry no auth headers), list
  responses, or the LLM prompt (the tester prompt names the auth _scheme_, not the
  token).
- **SSRF guard.** Every URL the worker fetches or exposes (manifest `baseUrl`, OAuth
  `tokenUrl`, the extracted env URL) must be https, carry no embedded credentials,
  and resolve to a public host (loopback/link-local/RFC1918 are rejected). A trusted
  operator can widen the host/scheme allow-list per facade to reach an internal
  platform: see [Reaching an internal / VPN-hosted platform](#reaching-an-internal--vpn-hosted-platform).
  Embedded credentials stay forbidden regardless.
