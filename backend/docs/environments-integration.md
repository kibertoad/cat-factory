# Ephemeral environment provider integration

Let a workspace plug in its **own** ephemeral/preview-environment tooling so a
`deployer` agent can provision an environment and a `tester` agent can run against
it. The integration is declarative and **API-only**: you describe your self-rolled
management API as an HTTP manifest — there are no provider presets and no code to
write. It is **opt-in** and wired exactly like the GitHub/Confluence modules.

This is the **sibling** of the [self-hosted runner pool](./runner-pool-integration.md):
same manifest machinery (auth schemes, `{{var}}` templating, dot-path response
mapping, SSRF guard, at-rest encryption), but it provisions a **preview deployment to
test against** rather than a **runner to execute agents on**. The work splits the same
way: a **Platform/Infra team** stands up the management API in front of your
environment tooling (k8s namespaces, a Vercel-style service, an internal provisioner);
an **Application team** writes the manifest and registers it per workspace.

See also [ADR 0003](./adr/0003-ephemeral-environment-provider.md). When your tooling is too
bespoke to describe declaratively, you can instead inject a hand-written **native adapter** —
see [Native environment adapters](./native-environment-adapter.md).

> **The connection is now per provision type, not one per workspace.** This doc describes the
> generic HTTP `manifest` backend, which today serves the **`custom` provision type** via the
> `remote-custom` engine. The single per-workspace `environment_connections` row has been
> reshaped into per-provision-type **handlers** (keyed by `(workspace_id, provision_type,
> manifest_id)`), and a service selects its type/source independently of the workspace's
> handler. A `kubernetes` service additionally has a native render/deploy path (raw apiserver
> apply, or kustomize/helm/Gateway via a deploy container). See
> [per-service-provisioning.md](./per-service-provisioning.md) for the full model, the engines,
> and the per-type / custom-type / detect endpoints. The legacy
> `/workspaces/:ws/environments/connection` endpoints below remain as the compat bridge.

## How it works (the sequence of actions)

1. A pipeline on an `environment` block reaches its **`deployer`** step. The engine
   calls `HttpEnvironmentProvider.provision` — interpolating your manifest's
   `provision` template (with `{{input.*}}` from the block) and `POST`ing to your
   management API with your auth. It runs **deterministically** (no LLM, no token
   spend) and persists an environment handle.
2. If your `provision` response is async, the cron sweep polls your `status` template
   until the mapped status reaches `ready` (or `failed`); the handle's URL + access
   creds are captured via the `response` dot-paths.
3. Downstream **`tester`** (and later) steps receive the live environment in their
   prompt context — the URL and how to authenticate — so they test the real build.
   (The tester job's `test.environmentUrl` is wired straight from this handle.)
4. When the handle's TTL elapses (from `expiresAtPath`, or `defaultTtlMs`), the cron
   sweep (every 2 min) calls your `teardown` template and tombstones the record.
   Teardown is best-effort and retried on the next pass.

## Enabling it

The feature is off unless enabled **and** a service-level encryption key is set
(per-tenant credentials are always stored encrypted — there is no plaintext
fallback):

```sh
# wrangler.toml
ENVIRONMENTS_ENABLED = "true"

# Credentials are sealed with the shared service-level master key (≥32 bytes, base64),
# which is already required service-wide (a secret):
openssl rand -base64 32 | wrangler secret put ENCRYPTION_KEY
```

That master key encrypts, at rest in D1, both the per-tenant provider credentials
and each provisioned environment's own access credentials (AES-256-GCM, per-record
salt + IV, HKDF-derived key, versioned `v1.…` envelope for rotation).

## The manifest

A manifest describes your management API. The worker's single generic
`HttpEnvironmentProvider` interprets it; nothing about your endpoints is assumed.

```jsonc
{
  "providerId": "acme-envs", // [a-z0-9-]
  "label": "Acme Ephemeral Envs",
  "baseUrl": "https://envs.acme.internal-is-blocked.example", // https, public host
  "auth": { "type": "bearer", "secretRef": { "key": "API_TOKEN" } },

  // provision/status/teardown: arbitrary method + path + body, with templating.
  "provision": {
    "method": "POST",
    "pathTemplate": "/environments",
    "bodyTemplate": "{\"ref\":\"{{input.blockId}}\",\"title\":\"{{input.title}}\"}",
  },
  "status": { "method": "GET", "pathTemplate": "/environments/{{provision.externalId}}" },
  "teardown": { "method": "DELETE", "pathTemplate": "/environments/{{provision.externalId}}" },

  // Map YOUR response shape onto the canonical handle via dot-paths.
  "response": {
    "urlPath": "data.url",
    "statusPath": "data.state",
    "statusMap": [
      { "from": "running", "to": "ready" },
      { "from": "building", "to": "provisioning" },
      { "from": "error", "to": "failed" },
    ],
    "externalIdPath": "data.id",
    "expiresAtPath": "data.expires_at", // epoch-ms, numeric string, or ISO
    // How the *provisioned env* itself is reached by the tester (per-env creds,
    // read from the provision response — distinct from the management-API auth):
    "access": { "scheme": "bearer", "tokenPath": "data.access_token" },
  },

  "defaultTtlMs": 3600000, // fallback TTL when no expiry returned
}
```

### Worked example — a PR-environment platform

Most preview-environment platforms expose three calls: "create an environment for
this PR", "get its status", "delete it" — and key the environment on the PR's git
ref. Here is a complete manifest for that common shape. A project/tenant slug the
platform requires (`my-project` below) isn't derivable from a block, so it lives as
a literal in the paths; the git ref + repo come from the
[git/PR/repo context](#gitprrepo-context-input-on-a-deployer-step):

```jsonc
{
  "providerId": "preview-envs",
  "label": "Preview Environments",
  "baseUrl": "https://envs.example.com/v2",
  "auth": { "type": "bearer", "secretRef": { "key": "API_TOKEN" } },

  // Create: target the PR by number + repo. The platform returns a stable "ref"
  // (or id) we capture and reuse on status/teardown.
  "provision": {
    "method": "POST",
    "pathTemplate": "/projects/my-project/prenvs",
    "bodyTemplate": "{\"git_ref\":{\"pr_number\":{{input.pullNumber}}},\"github\":{\"owner\":\"{{input.repoOwner}}\",\"repo\":\"{{input.repoName}}\"}}",
  },
  // Status/teardown address the env by the ref captured from the provision response.
  "status": {
    "method": "GET",
    "pathTemplate": "/projects/my-project/prenvs/{{provision.externalId}}",
  },
  "teardown": {
    "method": "DELETE",
    "pathTemplate": "/projects/my-project/prenvs/{{provision.externalId}}",
  },

  "response": {
    "externalIdPath": "data.ref", // the per-PR ref, reused as {{provision.externalId}}
    "urlPath": "data.url",
    "statusPath": "data.status",
    "statusMap": [
      { "from": "pending", "to": "provisioning" },
      { "from": "online", "to": "ready" },
      { "from": "failed", "to": "failed" },
      { "from": "deleting", "to": "tearing_down" },
      { "from": "deleted", "to": "torn_down" },
    ],
  },
  "defaultTtlMs": 3600000,
}
```

Two things to check against your platform's real API:

- **Where the URL lives.** `urlPath` reads a single string via a dot-path
  (`data.url`, or an array index like `data.links.0.href`). If your platform returns
  the reachable URL only inside a nested/array-valued or templated structure that a
  dot-path can't pull out cleanly, you have outgrown the manifest path — use the
  [code-adapter seam](#code-adapter-seam-when-the-manifest-isnt-enough).
- **Async provisioning.** If create returns before the environment is live, supply a
  `status` template; the cron sweep polls it until `statusMap` yields `ready` (or
  `failed`). A synchronous platform that returns a ready URL can omit `status`.

### Templating

- `{{input.*}}` — provision inputs. On a pipeline `deployer` step these are derived
  from the block (`blockId`, `title`, `type`, `description`, `features`) plus the
  **git/PR/repo context** below; on a manual provision they come from the request
  `inputs` (plus `blockId`). Explicit request `inputs` always win over the derived
  values.
- `{{provision.*}}` — fields captured from the provision response (`externalId`,
  `url`), available to `status`/`teardown`.
- Unknown references resolve to empty — a manifest can't reach arbitrary state.

#### Git/PR/repo context (`{{input.*}}` on a `deployer` step)

A preview/PR-environment platform almost always keys an environment on **the git
ref it is building** and **the repo it belongs to**, not on an opaque block id. So
the `deployer` step derives that context from the block's open PR and exposes it
both as flattened `{{input.*}}` strings (for the manifest path) and as a typed
object for a [code adapter](#code-adapter-seam-when-the-manifest-isnt-enough). Each
is present only when known (a manual provision, or a block with no PR, carries
fewer):

| Variable               | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| `{{input.blockId}}`    | The board block being deployed (always present).         |
| `{{input.branch}}`     | The head branch the agent pushed its work to.            |
| `{{input.pullNumber}}` | The pull request number within the repo (e.g. `42`).     |
| `{{input.pullUrl}}`    | The pull request web URL.                                |
| `{{input.repoOwner}}`  | The repo owner (org/user login), parsed from the PR URL. |
| `{{input.repoName}}`   | The repo name, parsed from the PR URL.                   |

This is what lets a manifest build a "create an environment for PR #N of
owner/repo" request without any per-block configuration. Note that any identifier a
platform needs which is **not** derivable from the block (a project/team/tenant
slug, a target cluster) is not in this namespace: bake it into the manifest as a
literal in the `pathTemplate`/`bodyTemplate`, or pass it as a manual-provision
`input`. Register one manifest per such project if they differ.

### Auth schemes (calling the management API)

Each references its secret(s) by **logical key**; values are supplied separately
(see below) and never appear in the manifest.

| `auth.type`                 | fields                                                                          | effect                                 |
| --------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| `none`                      | —                                                                               | no auth header                         |
| `api_key`                   | `headerName`, `secretRef`, `valuePrefix?`                                       | `headerName: <prefix><secret>`         |
| `bearer`                    | `secretRef`                                                                     | `Authorization: Bearer <secret>`       |
| `basic`                     | `usernameSecretRef`, `passwordSecretRef`                                        | `Authorization: Basic base64(u:p)`     |
| `oauth2_client_credentials` | `tokenUrl`, `clientIdSecretRef`, `clientSecretSecretRef`, `scope?`, `audience?` | POST token → `Authorization: Bearer …` |
| `custom_headers`            | `headers: [{ name, secretRef }]`                                                | each header set from its secret        |

## Code-adapter seam (when the manifest isn't enough)

The manifest path is declarative and code-free, but a single `fetch` + dot-path
mapping can't express everything: a platform that paginates, needs a multi-step
handshake, returns the env URL inside a structure no dot-path can address, signs
requests in a bespoke way, or wants the typed git/PR/repo context as real fields
rather than interpolated strings. For those, a **trusted, operator-installed** code
adapter replaces the generic HTTP provider while keeping the rest of the
integration (the connection registry, secret encryption, TTL sweep, agent-context
surfacing) unchanged.

An adapter implements the `EnvironmentProvider` port (`@cat-factory/kernel`):

```ts
import type {
  EnvironmentProvider,
  ProvisionEnvironmentRequest,
  ProvisionedEnvironment,
} from '@cat-factory/kernel'

export class MyEnvironmentProvider implements EnvironmentProvider {
  async provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment> {
    // Typed context — no string parsing. Present when the block has an open PR.
    const ctx = req.provisionContext // { branch?, pullNumber?, pullUrl?, repoOwner?, repoName?, blockId? }
    const token = req.resolveSecret('API_TOKEN') // resolved from the encrypted bundle
    // ...call your platform however it needs to be called...
    return {
      externalId: createdRef,
      url: liveUrl, // SSRF-guarded by the engine before it is stored
      status: 'ready', // or 'provisioning' for async — status() is polled
      expiresAt: null, // epoch ms, or null to use defaultTtlMs
      access: null, // per-env creds for the tester, when applicable
      fields: { ref: createdRef }, // arbitrary, persisted (encrypted) for status/teardown
    }
  }
  async status(req) {
    /* read live status; `req.provisionFields` carries `fields` back */
  }
  async teardown(req) {
    /* destroy; best-effort, retried by the sweep */
  }
}
```

The adapter still registers a connection (so secrets are encrypted at rest and the
module assembles), but the `manifest`'s request templates are ignored in favour of
your code — the `secrets`, `providerId`, and `label` still apply. Define the backend as a
value and **register it by reference** into the app-owned registry, under a custom `kind`:

```ts
import type { EnvironmentBackendProvider } from '@cat-factory/integrations'

export const myPlatformBackend: EnvironmentBackendProvider = {
  kind: 'my-platform', // a lower-kebab slug, not a reserved built-in
  displayLabel: 'My Platform',
  referencedSecretKeys: () => ['API_TOKEN'],
  connectionMeta: (c) => ({
    providerId: 'my-platform',
    label: c.manifest.label,
    baseUrl: c.manifest.baseUrl,
  }),
  assertConfigSafe: () => {},
  toManifest: (c) => c.manifest, // a custom kind rides the generic manifest member
  fromManifest: (manifest) => ({ kind: 'my-platform', manifest }),
  // REQUIRED: the per-type infra engine(s) this backend serves. A BYO ephemeral-environment
  // backend rides `remote-custom`, which makes it selectable for a service's `custom` provision
  // type. A backend that declares no engine is unreachable as a run target.
  engines: () => ['remote-custom'],
  buildProvider: (ctx) => new MyEnvironmentProvider(ctx),
}

// at the composition root (e.g. via start()'s `buildContainer` seam):
const backendRegistries = createBackendRegistries()
backendRegistries.environmentBackendRegistry.register(myPlatformBackend)
// …pass `backendRegistries` into buildNodeContainer / buildContainer.
```

The registry is **app-owned and injected** (no deployment-wide provider singleton): it resolves
a workspace's stored `kind` to your backend on Worker / Node / local alike, and registration is
by reference so module identity never matters. Full model + the single-tenant-vs-multi-tenant
rationale: [`native-environment-adapter.md`](./native-environment-adapter.md).

Because the adapter is code you install and run, the URL it returns is still
SSRF-guarded by the engine. To let it reach an internal platform, widen the URL
policy (next section).

## Reaching an internal / VPN-hosted platform

By default every URL the integration fetches or exposes must be public `https` (see
[Security notes](#security-notes)). A platform reachable only on an internal/VPN host
(`*.internal`, an RFC1918 address) is rejected by that guard. A **trusted operator**
(not an arbitrary workspace) can widen the guard per facade so the manifest
`baseUrl`, the OAuth `tokenUrl`, and the returned env URL may use specific
hosts/schemes:

| Setting (env var / Worker `[vars]`) | Effect                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENTS_ALLOW_URL_HOSTS`      | Comma-separated hostnames exempt from the private/internal-host block. Each entry matches the URL host exactly (`envs.corp`, `10.1.2.3`), or as a dot suffix when it starts with `.` (`.internal` matches `a.b.internal`). |
| `ENVIRONMENTS_ALLOW_HTTP_URLS`      | `true` to also permit `http` (not just `https`).                                                                                                                                                                           |

```toml
# wrangler.toml (Worker)  —  or env vars on the Node facade
ENVIRONMENTS_ALLOW_URL_HOSTS = "envs.corp.internal,.preview.internal"
ENVIRONMENTS_ALLOW_HTTP_URLS = "false"
```

The widening only exempts the hosts you list; everything else stays strict, and
embedded URL credentials are forbidden regardless. Leave both unset (the default) to
keep the strict public-https guard everywhere.

> The runner-pool integration has the matching `RUNNERS_ALLOW_URL_HOSTS` /
> `RUNNERS_ALLOW_HTTP_URLS` knobs. The two integrations are scoped **independently** —
> each resolves its own policy from its own settings, so a host you allow here does
> **not** become reachable by the runner pool (and vice versa). Set each one's
> allow-list to exactly what that integration needs.

## Registering a provider

Supply the manifest and the **actual secret values** for every `secretRef.key` it
references. The values are encrypted and stored; they are never returned.

```sh
curl -X POST $API/workspaces/$WS/environments/connection \
  -H 'content-type: application/json' \
  -d '{
        "manifest": { ... },
        "secrets": { "API_TOKEN": "real-token-value" }
      }'
```

- `GET /workspaces/:ws/environments/connection` → safe metadata + `secretKeys`
  (names only).
- `PUT /workspaces/:ws/environments/connection/secrets` → rotate the secret bundle.
- `DELETE /workspaces/:ws/environments/connection` → unregister.

## Provisioning & discovery

The intended flow is a pipeline on an `environment` block with agent kinds
`["deployer", "tester"]`:

1. The **`deployer`** step runs deterministically (no LLM, no token spend): the
   engine calls the provider, persists the environment, and writes a summary to the
   step output.
2. The **`tester`** step (and any later step) receives the live environment in its
   prompt context — the URL and how to authenticate — so it tests the real build.

You can also drive it directly:

- `POST /workspaces/:ws/environments/provision` `{ blockId?, inputs? }` → handle
- `GET  /workspaces/:ws/environments` → handles (no credentials)
- `GET  /workspaces/:ws/environments/:id` → one handle (no credentials)
- `GET  /workspaces/:ws/environments/:id/access` → the **decrypted** access creds
  (the only endpoint that returns them; over TLS)
- `POST /workspaces/:ws/environments/:id/teardown` → tear down now

## TTL & teardown

If a provisioned environment has an expiry (from `expiresAtPath`, or `defaultTtlMs`),
the cron sweep (every 2 min) calls the manifest's `teardown` and tombstones the
record once it elapses. Teardown is best-effort: a transient provider failure is
retried on the next pass rather than wedging the registry.

## Security notes

- **Encryption at rest.** The per-tenant secret bundle and every env's access creds
  are AES-256-GCM ciphertext in D1; only the service-level master key lives in env.
- **No secret leakage.** Secrets are placed only in outgoing request headers — never
  in logs, error bodies (which are length-capped and carry no auth headers), list
  responses, or the LLM prompt (the tester prompt names the auth _scheme_, not the
  token).
- **SSRF guard.** Every URL the worker fetches or exposes (manifest `baseUrl`, OAuth
  `tokenUrl`, the extracted env URL) must be https, carry no embedded credentials,
  and resolve to a public host (loopback/link-local/RFC1918 are rejected). A trusted
  operator can widen the host/scheme allow-list per facade to reach an internal
  platform — see [Reaching an internal / VPN-hosted platform](#reaching-an-internal--vpn-hosted-platform).
  Embedded credentials stay forbidden regardless.
