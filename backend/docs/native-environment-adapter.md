# Native environment adapters

> **Choosing between a manifest and code is on the website**:
> [Provision Ephemeral Environments](https://www.catfactory.ai/operate/environments.html#when-the-manifest-isn-t-enough)
> owns that decision and
> [Custom Providers](https://www.catfactory.ai/extend/custom-providers.html) owns the seam.
> This page is the CONTRACT for writing one adapter.

cat-factory provisions **ephemeral environments** (the live URLs the Tester agent runs
against) through the `EnvironmentProvider` port. The default implementation,
`HttpEnvironmentProvider`, is fully generic: it interprets a declarative **manifest** of
HTTP request templates, so one stateless instance serves any org whose preview-env tooling
exposes a REST API.

When an org's tooling is too bespoke to describe declaratively (say an in-house ephemeral-environment
system whose environments are keyed by project + git ref and whose links/status need
provider-specific logic), you write a **native adapter** instead: a hand-written
`EnvironmentProvider`. This document is the contract for writing one, using a fictional
in-house provider called **acme-envs** as the running example.

> **Wiring in one line:** the env subsystem uses an **app-owned backend registry** keyed by
> a `kind` discriminator (mirroring the runner-pool backends): you register an
> `EnvironmentBackendProvider` **by reference** into the `EnvironmentBackendRegistry` the
> facade builds (`registry.register(provider)`), and a workspace selects your `kind` at
> connect time. The built-in `kubernetes` backend
> (`backend/packages/integrations/src/modules/environments/environment-backends.ts`) is the
> worked example. There is no facade injection option (the old
> `buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`
> singletons were removed). The `EnvironmentProvider` port below is unchanged: your registered
> backend's `buildProvider` returns one. Full detail in [Registering the backend](#registering-the-backend).

## The port

A native adapter implements three methods (`backend/packages/kernel/src/ports/environment-provider.ts`):

```ts
interface EnvironmentProvider {
  provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment>
  status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment>
  teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }>
}
```

Restarting a workload in place is the one further verb the engine drives, and it is opt-in rather
than part of this interface: see [`diagnostics`](#diagnostics-explaining-and-repairing-an-environment-that-never-came-up)
below. Nothing else has been added on request, so the base port stays these three.

A native adapter MAY additionally implement three optional methods so the SPA can render
a first-class **connect form** instead of making operators hand-author a manifest:

```ts
describeConfig?(manifest?: EnvironmentManifest): ProviderConfigField[]
describeManifestTemplate?(): EnvironmentManifest
testConnection?(req: EnvironmentConnectionTestRequest): Promise<ConnectionTestResult>
```

- **`describeConfig`** declares the flat fields the org fills in: `key`, `label`, `help`,
  `secret`, `required`, and an optional **`default`**. A `required` field with no `default`
  and no stored value is what lights up the unconfigured-provider banner
  (`ProviderDescriptor.missingRequired`); a field with a `default` is optional (the UI
  shows it blank with a "defaulted to …" hint and falls back to the default).
- **`describeManifestTemplate`** returns the base manifest the SPA overlays those field
  values onto, so the form is flat but storage stays a single full manifest (no divergent
  no-manifest path). A `secret` field is written to the secret bundle (your template's
  `auth` already references its key); a non-secret field to `providerConfig[key]`; a field
  named `baseUrl` to `baseUrl`. The template supplies the parts no flat field carries: the
  `auth` scheme, the `provision`/`status`/`teardown` request templates (ignored at run time
  but required by the schema), and `response`. It carries **no secret values**: only the
  shape + secret-ref keys.

Omit them and the adapter still works; the SPA just falls back to editing the manifest
directly. Implement them to get the typed/defaulted connect form + the banner.

Every call receives the per-workspace `manifest` plus a `resolveSecret(key)` callback. A
`provision` call additionally gets `inputs` (`{{input.*}}` template vars) and a typed
`provisionContext` (`branch` / `pullNumber` / `pullUrl` / `repoOwner` / `repoName` /
`blockId`) derived from the block under deployment. `status`/`teardown` get the `externalId`
and the `provisionFields` captured at provision time.

### `confirmTeardown`: proving the environment is gone

A fourth optional method, and the difference between a reported reclaim and a proven one. The
`TeardownProbe` shape and the three rules for writing one (under-claim, what `terminating` and
`retryable` decide, and why `status()` must not answer instead) are on the website's
[teardown probe](https://www.catfactory.ai/extend/custom-providers.html#proving-a-teardown).

What stays here is where the verdict GOES. Omitting the method is a supported choice rather than a
bug: the teardown is recorded as `unverifiable` and reported as such, never as a reclaim. The probe
is bounded in wall-clock time by the service (awaited inline on an on-demand teardown and on the TTL
sweep), so an unresponsive one costs the confirmation and never the teardown. Which paths record
which verdict, and what a `disposer` step does with them:
[`environment-disposal-and-teardown-proof.md`](../../docs/initiatives/environment-disposal-and-teardown-proof.md).

### `diagnostics`: explaining, and repairing, an environment that never came up

A fifth optional member, and the one the engine reads when a provision fails for a cause no edit in
the repository could address. `describe` returns named control-plane facts, log excerpts and the
reads the adapter could NOT make; `supportedActions` declares what it will perform (today only
`restart`); `remediate` performs one. The shape, and the four rules a first implementation gets
wrong, are on the website's
[diagnostics capability](https://www.catfactory.ai/extend/custom-providers.html#diagnosing-an-environment-that-never-came-up).

Separate from `status()` for the reason `confirmTeardown` is: `status()` answers a readiness
question in one word, so every implementation reduces a rich answer to a member of
`EnvironmentStatus` and drops the rest, and a provider that cannot answer the NEW question must be
able to say so rather than have an answer inferred from a call meant for something else.

What stays here is where the answer goes. The evidence is assembled with the platform's own (the
environment record, the whole captured provision-field bag, the run's provisioning timeline) and
read by an INLINE model call, never a container: the credentials that produced it must not ride a
job body. The model picks one action from a list the engine narrowed first, the engine performs it,
and the deployer then re-enters its own path, so what settles the frame is the provider's next
verdict rather than the verdict about it. Standing an environment up again and tearing one down are
driven through the methods above and never asked of `remediate`. Omitting the whole member is a
supported choice: the investigation runs on the platform's evidence alone and STATES that it did.
Full model: [`environment-investigation.md`](../../docs/initiatives/environment-investigation.md).

### Saying WHY an environment is not ready yet: `statusNote`

An async provision means every poll until the environment lands answers `provisioning`, and the
deployer waits on those answers for up to `ENVIRONMENT_READY_TIMEOUT_MS` (20 minutes) before it
records the frame failed. `ProvisionedEnvironment.statusNote` is what that wait reads: one sentence
saying where the environment is.

**It is not `error`.** `error` is read only on `status: 'failed'`, and both persistence sites null it
on every other status, so before this field a provider that knew exactly which stage an environment
was stuck at had nowhere to put it. The ceiling could report only its own duration, and the only
workaround was to report `failed` early purely because `failed` was the only status whose reason
survived persistence: a truthful lifecycle state traded for an explainable one.

Three rules:

- **Say what distinguishes THIS poll from the last one.** "the deploy job has not started" and "the
  deploy succeeded and no target went healthy" are both `provisioning`, and which one it is decides
  who looks at what. A note that repeats the status word adds nothing.
- **It is the current account, never a log.** Like `error`, it is re-read from you and rewritten on
  every poll, so a note you stop returning stops being stored. Nothing accumulates, and a note
  cannot outlive the state it described.
- **Absent means nothing to add**, which is byte-for-byte the prior behaviour. A provider that
  never sets it keeps exactly today's messages.
- **It is bounded.** A note is stored capped at 400 characters, with a marker saying how much was
  dropped, because it renders as one muted line beside an environment that is doing fine (the
  fault beside it gets its own scrollable block). Write the sentence, not the controller dump.

Where it surfaces: the step's Environment panel while the run is parked, the run outcome's
environment row, and the `timed_out` failure detail (`Last provider note: …`), which is the message
a human reads when the ceiling is spent. The built-in Kubernetes adapter is the worked example: it
names the Deployments that have not finished rolling out, and distinguishes a workload that is still
coming up from one that is healthy behind an Ingress nothing has routed yet.

**A recorded fault outranks a note on every one of those readers**, so you may set both without
deciding which wins: where a `failed` status carries an `error`, that error is what a person is
shown. Which is also the obligation on the other half of the pair. `error` unset on a `failed`
status is persisted as the literal `Provisioning failed`, and a reader given that sentence learns
only that something did not happen, so a failure your adapter can NAME should name it (the built-in
Kubernetes adapter names the workload whose rollout gave up, and says when the namespace is gone).

### What `fields` is for, and what a POLL does to it

`ProvisionedEnvironment.fields` is your own bag: whatever your adapter needs to interpolate the
later status and teardown calls, sealed on the environment row and never exposed on a handle. It is
also the evidence the environment investigation reasons from, and that second reader is why the
write rule matters.

- **A stated bag REPLACES the stored one, whole.** It is what THIS response captured, not an
  accumulator, so a key you stop stating stops being stored. The same clear-unless-restated rule as
  `error` and `statusNote`.
- **`null` states nothing and keeps what is stored.** Return it from a call that read nothing (the
  generic provider's no-`status`-template fallback does; so does the built-in Kubernetes adapter
  when the row carries no namespace to read a status from). Absent is not empty, and the difference
  is load-bearing: an empty bag from a status endpoint answering a narrower shape than your create
  endpoint would erase the teardown state the create response supplied.
- **Write what a poll LEARNS, not just what the create knew.** For an async provider the create
  response is the least informative answer you will ever give: no finished deploy job, no load
  balancers, no readiness detail. Everything worth capturing arrives on a later poll, so state the
  balancer FQDNs, the upstream's own status word and any readiness detail on every poll that has
  them. Until [#2162](https://github.com/kibertoad/cat-factory/issues/2162) the platform handed the
  bag back to the provider and then persisted a patch that omitted it, so an adapter doing exactly
  this was writing into a field nothing ever read: the fields were frozen at create time for the
  life of the environment, and an investigation later read a create-time `pending` sitting beside a
  `ready` row as the platform contradicting itself.
- **An ADDRESS is not a field.** Addresses go on `ProvisionedEnvironment.addresses`, which is
  proved and reaches a container bridge; a bag entry reaches nobody who could dial it. See
  [ADR 0062](./adr/0062-environment-address-bridge-and-route-proof.md).
- **Secrets are redacted on the way to a prompt, not before.** The bag is sealed at rest, and the
  investigation's gatherer scrubs it by key and value. That is a net, not permission: keep a
  credential out of it if the later calls do not need one.

### `frontendOrigins`: wiring a bound frontend's CORS

When a `deployer` step provisions a service that one or more `frontend` frames bind (via the
frontend's `backendBindings`), the engine passes an extra input, `frontendOrigins`: the
comma-joined browser origins of those frontends (e.g. `http://localhost:4173`), the reverse of
the frontend→service binding. Fold it into the deployed backend's **CORS allow-list** (and any
OAuth-callback allow-list) so the ephemeral frontend can actually reach the ephemeral backend:

- **HTTP-manifest provider:** reference `{{input.frontendOrigins}}` in a request `bodyTemplate` /
  header / query.
- **Kubernetes native adapter:** reference `{{frontendOrigins}}` (FLAT, like `{{branch}}` /
  `{{namespace}}`) in a `secretInjections` `valueTemplate` or a helm `--set`, e.g. a
  `generatorEnvFile` entry `{ key: 'CORS_ALLOWED_ORIGINS', valueTemplate: '{{frontendOrigins}}' }`.

The key is **absent when no frontend binds the service**. The origin derivation is automatic; the
mapping into your CORS env var is operator-authored (the env-var name is app-specific), and CORS is
baked at provision time: **re-provision** the backend to pick up a newly-linked frontend or a
changed `servePort`. (For zero-config local dev you can instead allow a `localhost` wildcard in your
manifest and skip the re-provision; exact-origin injection is the recommended path.)

## Registering the backend

The registration walkthrough is on the website:
[Custom Providers → Wire it in](https://www.catfactory.ai/extend/custom-providers.html#wire-it-in)
owns the `EnvironmentBackendProvider` shape, the `createBackendRegistries()` bundle, both facades'
entry points, and the by-reference rule. Two facts about the seam ITSELF stay here, because both are
about why the platform is arranged this way rather than about wiring one adapter:

- **There is no facade injection option for a provider**, and there deliberately isn't one. The old
  `buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })` singletons
  were removed: a deployment-wide provider cannot serve two workspaces on different platforms, and
  selection is a per-workspace fact. `EnvironmentConnectionService` resolves a workspace's stored
  connection `kind` to the registered backend and builds its provider, on every runtime.
- **Because registration is by reference into the injected registry, module identity does not
  matter.** There is no "you must share the same `@cat-factory/integrations` instance" footgun, and
  a custom kind rides the contract's generic manifest member
  (`environmentBackendConfigSchema`), so it needs no new config variant, table, service, controller
  or UI window. It becomes an option in the connect form, advertised to the SPA through the
  workspace snapshot's `environmentBackendKinds`: the descriptor-driven flat fields when your
  provider implements `describeConfig` / `describeManifestTemplate`, else the raw manifest editor.

Registering code is something only a deployment OWNER can do (you cannot let an arbitrary tenant
inject a provider), which is why this is the self-hosted extension path; a multi-tenant deployment
still offers the built-in `manifest` / `kubernetes` kinds per workspace.

### Also register a custom manifest type (for `remote-custom` backends)

Registering the backend only teaches the platform **how** a `custom`-type environment is stood
up (the `remote-custom` "how"). It does **not** by itself let a service _choose_ `custom`
provisioning: a service pins a **`manifestId`** drawn from the **custom-manifest-type catalog**,
and a `remote-custom` handler declares which id it `acceptsManifestId`. If that catalog is empty,
the service inspector's provisioning picker shows _"No custom manifest types are defined yet. Add
one in the Infrastructure window."_ and your backend is unreachable, even though it is registered
and declares `engines: ['remote-custom']`.

The catalog (`aggregateCustomManifestTypes`,
`backend/packages/integrations/src/modules/environments/custom-manifest-types.ts`) merges two
sources by `manifestId`:

- **Code-registered** entries in the injected `CustomManifestTypeRegistry`: the same by-reference
  seam as the backend, so a deployment that ships a `remote-custom` backend registers a matching
  type alongside it:

  ```ts
  backendRegistries.customManifestTypeRegistry.register({
    manifestId: 'acme-envs', // what a service pins and the handler's `acceptsManifestId` matches
    label: 'Acme envs',
    description: 'Ephemeral environment, provisioned from the repo config.',
    // Optional: prefilled onto a service's `manifestPath` on selection + the seed for path
    // auto-detection (a complete path, or a bare filename searched one level deep).
    defaultManifestPath: '.acme-envs/env.yaml',
    // Optional: the coding-agent prompt for the service inspector's "Generate / fix" button
    // (generate the manifest when missing, fix it when invalid). Absent ⇒ no button.
    fixerPrompt:
      'Author a valid acme-envs manifest describing this service (image, ports, health check).',
  })
  ```

- **Workspace-defined**, UI-editable rows (the Infrastructure window's custom-type editor),
  persisted in `custom_manifest_types` and merged over the code-registered set.

So a self-hosted deployment that ships a bespoke `remote-custom` backend should register **both**
the backend and its manifest type at boot: register the backend without the type and the picker
stays empty. (A `kubernetes`/`docker-compose`/`local-*` backend needs no manifest type; only the
open `custom` catalog is keyed this way.) See
[`per-service-provisioning.md`](./per-service-provisioning.md#custom-manifest-types-the-open-custom-catalog)
for the full catalog model.

### Per-workspace config rides the manifest

A backend's provider is built once per `kind` from the registry and is stateless, so the
**only** per-workspace data it ever sees is the per-call `manifest` (+ `inputs` /
`provisionContext`). So per-workspace settings (e.g. the **provider-side project**) must travel on
the manifest, via the opaque **`providerConfig`** bag
(`backend/packages/contracts/src/environments.ts`):

```ts
// environmentManifestSchema
providerConfig: v.optional(v.record(v.string(), v.unknown())),
```

`HttpEnvironmentProvider` ignores `providerConfig` entirely; a native adapter reads and
validates it off `req.manifest.providerConfig`. It serializes inside the existing
`manifest_json` JSON column on both runtimes (D1 + Drizzle): **no migration**, automatic
cross-runtime parity.

#### Re-read it, and validate what the OPERATION uses

Validate the bag on the way out with `parseStoredProviderConfig(schema, raw, label)` rather than
asserting it. The connect form did validate it on the way in, but the value has been through
storage since: a config written before a schema change, or edited in the database, otherwise flows
on as a fake-valid object and misbehaves deep inside a provision instead of being named here.

Then split that read by what each call actually reads, because the two halves fail in opposite
directions. **A provision should refuse an off-contract config**, having no honest way to build
from one. **A teardown should not**: refusing there leaves a live namespace, cluster or preview
with nothing able to delete it, and nothing later fixes that by itself, so the sweep re-fails on
the same parse forever while the resource keeps costing money. So parse the CONNECTION on the
reclaim paths (`teardown` + `confirmTeardown`) and the full config everywhere else. The built-ins
model this: `kubernetesConnectionConfigSchema` carries the apiserver URL and its TLS settings and
nothing about manifests or URL derivation, and the Kubernetes provider's `parseConnection` is the
seam a subclass widens (the EKS one adds the AWS coordinates its token is minted from).

The fields the reclaim itself reads stay validated: there is no safe default for which cluster to
send a `DELETE` to, and a GitHub Enterprise deployment whose API root silently fell back to the
public one would post its teardown to the wrong host. Forgive drift in what you do not read, never
in what you do.

### The connection is required, and that is intended

The environments module assembles when **`ENCRYPTION_KEY`** is set (it is always set:
the always-on document/task sources require it), and a workspace provisions only once **a
connection is registered** for it. This is not a quirk to design around: the connection is
the per-workspace anchor that

- holds the **sealed token** (resolved at call time via `resolveSecret` using the manifest
  `auth` scheme), and
- carries the per-workspace **`providerConfig`**.

So a native adapter's connection is **not** a dummy. Map the manifest fields like this:

| Manifest field                                        | Native adapter use                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `baseUrl`                                             | the provider's API root (the adapter reads it)                   |
| `auth` + `resolveSecret`                              | the per-workspace machine token                                  |
| `providerConfig`                                      | per-workspace native settings (project, link key, status map, …) |
| `provision`/`status`/`teardown` request **templates** | **the only** fields a native adapter legitimately ignores        |
| `response`, `defaultTtlMs`                            | optional: the adapter may honour or ignore them                  |

> We considered letting a registered backend declare "I need no manifest/connection" so the
> module could assemble from deployment env alone (a zero-connection single-tenant default).
> We rejected it: that loses per-workspace tokens and config and adds a divergent assembly
> path. The `providerConfig` bag gives the same flexibility while keeping a single assembly
> path, so even a single-tenant install registers its backend (code) and connects one
> workspace (secrets) rather than relying on an implicit deployment-wide provider.

## Environment port vs runner port: don't confuse them

- **`EnvironmentProvider`** = where the **Tester runs its tests** (a provisioned app URL).
- **`RunnerTransport` / `RunnerPoolProvider`** = where cat-factory's **executor-harness
  coding agents run** (coder, mocker, merger, …).

Ephemeral environments are **environments**: implement `EnvironmentProvider`. A _runner_ backed by the same
provider (mapping its CI jobs / AI sandboxes onto the executor-harness) is a separate
piece, but it uses the **exact same extension pattern**: see [Custom runner backends](#custom-runner-backends).

## Custom runner backends

The self-hosted runner-pool subsystem is the mirror image of this one, so a custom runner
backend is registered the same way: `backendRegistries.runnerBackendRegistry.register(provider)`
on the `RunnerBackendRegistry` (from `@cat-factory/integrations` via `createBackendRegistries()`),
where `provider` is a `RunnerBackendProvider`, the analogue of
`EnvironmentBackendProvider`, with `buildTransport(config, ctx) → RunnerTransport` and
`testConnection` in place of `buildProvider`. It rides the generic
`runnerBackendConfigSchema` manifest member (no new config variant), is advertised to the SPA
via the snapshot's `runnerBackendKinds`, and is selectable per workspace in the same connect
form (under "container agents → runner pool"). The same single-tenant-vs-multi-tenant story
applies. (The `runnerPoolProvider` facade option is unrelated: it only swaps the HTTP client
the built-in `manifest` pool reuses, not a custom-kind seam.)

## Teardown & TTL

cat-factory's TTL sweeper (`EnvironmentTeardownService.sweepExpired`) calls `teardown` and
**always tombstones the local record even if the provider returns 404**, so teardown is
idempotent and an already-gone environment never wedges the registry. A provider with its
own auto-expiry (e.g. an `online_until` cap) coexists safely: cat-factory owns teardown of
the environments it created; the provider's auto-expiry is a backstop. Make your adapter's
`teardown` tolerant of an already-deleted environment (treat 404 as success).

Tombstoning is bookkeeping, not proof: whether the resource actually went away is a separate probe,
which is why [`confirmTeardown`](#confirmteardown-proving-the-environment-is-gone) exists.

## Dependency: `@cat-factory/kernel`

Native adapters depend on **`@cat-factory/kernel`** for the port types: add it as a direct
dependency. All of these are exported from its entry point:

`EnvironmentProvider`, `ProvisionContext`, `ProvisionEnvironmentRequest`,
`EnvironmentStatusRequest`, `EnvironmentTeardownRequest`, `ProvisionedEnvironment`,
`ProvisionFields`, `SecretResolver`, `UrlSafetyPolicy`.

The contract/domain types (`EnvironmentManifest`, `EnvironmentStatus`,
`EnvironmentAccessHandle`) come from `@cat-factory/kernel` (which re-exports the
`@cat-factory/contracts` wire shapes). The SSRF guard `assertSafeEnvironmentUrl` is exported
from `@cat-factory/integrations` (`environmentsLogic.assertSafeEnvironmentUrl`).

> **Security:** `providerConfig` is freeform and is **not** covered by the manifest URL/SSRF
> checks (which only guard `baseUrl` / `tokenUrl`). If your adapter reads a URL or host out
> of `providerConfig`, guard it yourself with `STRICT_URL_SAFETY_POLICY` /
> `assertSafeEnvironmentUrl` before fetching it.

## Reference: a native ephemeral-environment adapter (sketch)

This is the `EnvironmentProvider` (the port) that
[`buildProvider`](#registering-the-backend) returns: wire it by defining a
`acmeEnvsEnvironmentBackend` value whose `buildProvider: (ctx) => new AcmeEnvsEnvironmentProvider(ctx.urlPolicy)`
and registering it by reference (`backendRegistries.environmentBackendRegistry.register(acmeEnvsEnvironmentBackend)`),
plus its custom manifest type (`backendRegistries.customManifestTypeRegistry.register({ manifestId: 'acme-envs', label: 'Acme envs' })`),
without which no service can pin the `custom` type (see [Also register a custom manifest type](#also-register-a-custom-manifest-type-for-remote-custom-backends)).

```ts
import type {
  EnvironmentProvider,
  ProvisionEnvironmentRequest,
  EnvironmentStatusRequest,
  EnvironmentTeardownRequest,
  ProvisionedEnvironment,
  EnvironmentStatus,
} from '@cat-factory/kernel'

const STATUS_MAP: Record<string, EnvironmentStatus> = {
  online: 'ready',
  ready: 'ready',
  creating: 'provisioning',
  pending: 'provisioning',
  failed: 'failed',
  error: 'failed',
  offline: 'torn_down',
  destroyed: 'torn_down',
}

export class AcmeEnvsEnvironmentProvider implements EnvironmentProvider {
  async provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment> {
    const cfg = req.manifest.providerConfig ?? {}
    const project = String(cfg.project ?? '') // per-workspace, validated here
    const token = req.resolveSecret('acme_envs_token')
    const gitRef = req.provisionContext?.pullNumber ?? req.provisionContext?.branch
    // POST {manifest.baseUrl}/environments  -> 202 pending environment
    const env = await this.call(req.manifest.baseUrl, token, 'POST', `/environments`, {
      project,
      git_ref: gitRef,
      github: {
        owner: req.provisionContext?.repoOwner,
        repo: req.provisionContext?.repoName,
      },
    })
    return this.toEnvironment(env)
  }

  async status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment> {
    const token = req.resolveSecret('acme_envs_token')
    const env = await this.call(
      req.manifest.baseUrl,
      token,
      'GET',
      `/environments/${req.externalId}`,
    )
    return this.toEnvironment(env)
  }

  async teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }> {
    const token = req.resolveSecret('acme_envs_token')
    try {
      await this.call(req.manifest.baseUrl, token, 'DELETE', `/environments/${req.externalId}`)
    } catch (err) {
      if (!isNotFound(err)) throw err // 404 == already gone == success
    }
    return { status: 'torn_down' }
  }

  private toEnvironment(env: AcmeEnv): ProvisionedEnvironment {
    const status = STATUS_MAP[env.status] ?? 'provisioning' // unknown -> keep polling
    return {
      externalId: env.id,
      url: pickTestableLink(env.links), // lowest-priority absolute-http link
      status,
      expiresAt: env.online_until ? Date.parse(env.online_until) : null,
      access: null,
      // The whole bag THIS response captured; it replaces the stored one. Return `null` from a
      // call that read nothing rather than `{}`, which would erase it. See `fields` above.
      fields: { project: env.project },
      // Why it is not ready YET, in the provider's own words: this is what the deployer's
      // readiness ceiling quotes instead of reporting only how long it waited. Absent on a
      // status that has nothing left to say. See `statusNote` above.
      ...(status === 'provisioning' && env.stage ? { statusNote: describeStage(env.stage) } : {}),
    }
  }
}
```

The open provider-side questions (status vocabulary, canonical link key/priority, machine-auth
scheme, create idempotency/timing, `git_ref` precedence) are answered by whoever owns the
provider and then encoded in the adapter and/or `providerConfig` (e.g. a
`providerConfig.statusMap` / `providerConfig.linkKey`), no cat-factory code change.
