# Native environment adapters

cat-factory provisions **ephemeral environments** (the live URLs the Tester agent runs
against) through the `EnvironmentProvider` port. The default implementation,
`HttpEnvironmentProvider`, is fully generic: it interprets a declarative **manifest** of
HTTP request templates, so one stateless instance serves any org whose preview-env tooling
exposes a REST API.

When an org's tooling is too bespoke to describe declaratively (e.g. **Kargo**, whose
PREnvs are keyed by project + git ref and whose links/status need provider-specific logic),
you write a **native adapter** instead — a hand-written `EnvironmentProvider`. This document
is the contract for writing one.

> **Wiring (updated):** a native adapter is no longer injected by replacing a deployment-wide
> provider singleton. The env subsystem now uses a per-workspace **backend registry** keyed by
> a `kind` discriminator (mirroring the runner-pool backends): you register an
> `EnvironmentBackendProvider` via `registerEnvironmentBackend(...)` as an import side effect,
> and a workspace selects your `kind` at connect time. The built-in `kubernetes` backend
> (`backend/packages/integrations/src/modules/environments/environment-backends.ts`) is the
> worked example. The old `buildNodeContainer({ environmentProvider })` /
> `startLocal({ environmentProvider })` injection option has been removed. The `EnvironmentProvider`
> port below is unchanged — your registered backend's `buildProvider` returns one.

## The port

A native adapter implements three methods (`backend/packages/kernel/src/ports/environment-provider.ts`):

```ts
interface EnvironmentProvider {
  provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment>
  status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment>
  teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }>
}
```

There is intentionally **no `reboot`** (YAGNI — nothing in the engine drives one). If a
provider supports rebooting, that is an out-of-band operation; the port stays minimal.

A native adapter MAY additionally implement three optional methods so the SPA can render
a first-class **connect form** instead of making operators hand-author a manifest:

```ts
describeConfig?(manifest?: EnvironmentManifest): ProviderConfigField[]
describeManifestTemplate?(): EnvironmentManifest
testConnection?(req: EnvironmentConnectionTestRequest): Promise<ConnectionTestResult>
```

- **`describeConfig`** declares the flat fields the org fills in — `key`, `label`, `help`,
  `secret`, `required`, and an optional **`default`**. A `required` field with no `default`
  and no stored value is what lights up the unconfigured-provider banner
  (`ProviderDescriptor.missingRequired`); a field with a `default` is optional (the UI
  shows it blank with a "defaulted to …" hint and falls back to the default).
- **`describeManifestTemplate`** returns the base manifest the SPA overlays those field
  values onto, so the form is flat but storage stays a single full manifest (no divergent
  no-manifest path). A `secret` field is written to the secret bundle (your template's
  `auth` already references its key); a non-secret field to `providerConfig[key]`; a field
  named `baseUrl` to `baseUrl`. The template supplies the parts no flat field carries — the
  `auth` scheme, the `provision`/`status`/`teardown` request templates (ignored at run time
  but required by the schema), and `response`. It carries **no secret values** — only the
  shape + secret-ref keys.

Omit them and the adapter still works; the SPA just falls back to editing the manifest
directly. Implement them to get the typed/defaulted connect form + the banner.

Every call receives the per-workspace `manifest` plus a `resolveSecret(key)` callback. A
`provision` call additionally gets `inputs` (`{{input.*}}` template vars) and a typed
`provisionContext` (`branch` / `pullNumber` / `pullUrl` / `repoOwner` / `repoName` /
`blockId`) derived from the block under deployment. `status`/`teardown` get the `externalId`
and the `provisionFields` captured at provision time.

## The injection contract

An injected provider is a **deployment-wide singleton**:

```ts
// Node facade:
buildNodeContainer({ db, environmentProvider: new KargoEnvironmentProvider() })

// Local facade (keeps local-mode preflight + differentiators):
startLocal({ environmentProvider: new KargoEnvironmentProvider() })
```

It **replaces** the default `HttpEnvironmentProvider` (`selectNodeEnvironmentsDeps(config,
db, override)` uses `override ?? new HttpEnvironmentProvider(...)`). The local facade's
`startLocal({ environmentProvider })` seam threads it through `buildLocalContainer` →
`buildNodeContainer` while preserving local mode's orphan reaping, PAT/auth warnings, the
local container transport, and the PAT-backed GitHub client. (`buildContainer` is
deliberately not exposed on `startLocal` — overriding it would discard those
differentiators.)

### Per-workspace config rides the manifest, not the constructor

Because the provider is a singleton, the **only** per-workspace data it ever sees is the
per-call `manifest` (+ `inputs` / `provisionContext`). So per-workspace settings — e.g. the
**Kargo project** — must travel on the manifest, via the opaque **`providerConfig`** bag
(`backend/packages/contracts/src/environments.ts`):

```ts
// environmentManifestSchema
providerConfig: v.optional(v.record(v.string(), v.unknown())),
```

`HttpEnvironmentProvider` ignores `providerConfig` entirely; a native adapter reads and
validates it off `req.manifest.providerConfig`. It serializes inside the existing
`manifest_json` JSON column on both runtimes (D1 + Drizzle) — **no migration**, automatic
cross-runtime parity.

### The connection is required — and that is intended

The environments module assembles only when **`ENVIRONMENTS_ENABLED=true`**,
**`ENCRYPTION_KEY`** is set, **and a connection is registered** for the workspace. This is
not a quirk to design around: the connection is the per-workspace anchor that

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
| `response`, `defaultTtlMs`                            | optional — the adapter may honour or ignore them                 |

> We considered letting an injected provider declare "I need no manifest/connection" so the
> module could assemble from deployment env alone. We rejected it: that loses per-workspace
> tokens and config and adds a divergent assembly path. The `providerConfig` bag gives the
> same flexibility while keeping a single assembly path.

## Environment port vs runner port — don't confuse them

- **`EnvironmentProvider`** = where the **Tester runs its tests** (a provisioned app URL).
- **`RunnerTransport` / `RunnerPoolProvider`** = where cat-factory's **executor-harness
  coding agents run** (coder, mocker, merger, …).

Kargo PREnvs are **environments** — implement `EnvironmentProvider`. A Kargo-backed
_runner_ (mapping Kargo CI jobs / AI sandboxes onto the executor-harness via the
`resolveTransport` seam) is a separate, larger piece and is **out of scope** until there is
a Kargo ↔ executor-harness story.

## Teardown & TTL

cat-factory's TTL sweeper (`EnvironmentTeardownService.sweepExpired`) calls `teardown` and
**always tombstones the local record even if the provider returns 404** — so teardown is
idempotent and an already-gone environment never wedges the registry. A provider with its
own auto-expiry (e.g. Kargo `online_until`) coexists safely: cat-factory owns teardown of
the environments it created; the provider's auto-expiry is a backstop. Make your adapter's
`teardown` tolerant of an already-deleted environment (treat 404 as success).

## Dependency: `@cat-factory/kernel`

Native adapters depend on **`@cat-factory/kernel`** for the port types — add it as a direct
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

## Reference: a native Kargo adapter (sketch)

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

export class KargoEnvironmentProvider implements EnvironmentProvider {
  async provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment> {
    const cfg = req.manifest.providerConfig ?? {}
    const project = String(cfg.project ?? '') // per-workspace, validated here
    const token = req.resolveSecret('kargo_token')
    const gitRef = req.provisionContext?.pullNumber ?? req.provisionContext?.branch
    // POST {manifest.baseUrl}/prenvs  -> 202 pending PREnv
    const prenv = await this.call(req.manifest.baseUrl, token, 'POST', `/prenvs`, {
      project,
      git_ref: gitRef,
      github: {
        owner: req.provisionContext?.repoOwner,
        repo: req.provisionContext?.repoName,
      },
    })
    return this.toEnvironment(prenv)
  }

  async status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment> {
    const token = req.resolveSecret('kargo_token')
    const prenv = await this.call(req.manifest.baseUrl, token, 'GET', `/prenvs/${req.externalId}`)
    return this.toEnvironment(prenv)
  }

  async teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }> {
    const token = req.resolveSecret('kargo_token')
    try {
      await this.call(req.manifest.baseUrl, token, 'DELETE', `/prenvs/${req.externalId}`)
    } catch (err) {
      if (!isNotFound(err)) throw err // 404 == already gone == success
    }
    return { status: 'torn_down' }
  }

  private toEnvironment(prenv: KargoPrenv): ProvisionedEnvironment {
    return {
      externalId: prenv.id,
      url: pickTestableLink(prenv.links), // lowest-priority absolute-http link
      status: STATUS_MAP[prenv.status] ?? 'provisioning', // unknown -> keep polling
      expiresAt: prenv.online_until ? Date.parse(prenv.online_until) : null,
      access: null,
      fields: { project: prenv.project },
    }
  }
}
```

The open Kargo-side questions (status vocabulary, canonical link key/priority, machine-auth
scheme, create idempotency/timing, `git_ref` precedence) are answered by the Kargo team and
then encoded in the adapter and/or `providerConfig` (e.g. a `providerConfig.statusMap` /
`providerConfig.linkKey`) — no cat-factory code change.
