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

> **A manifest is the last resort, not the first.** Three backends ship in the box and need none:
> `kubernetes`, `eks` and `cloudflare`; choosing between them is the site's
> [Choosing a backend](https://www.catfactory.ai/operate/environments.html#choosing-a-backend).
> The one design fact that belongs here is why `cloudflare` is available where the others are not:
> it stands its per-PR Worker up by driving the target repository's OWN preview workflow over the
> VCS Deployments API, so it needs nothing but outbound HTTPS and therefore works on every facade,
> including the Cloudflare Worker one that has no Docker daemon and no filesystem. Its reference
> workflow lives in [`deploy/preview`](../../deploy/preview/README.md); wiring it to a board is
> [`docs/internal/dogfooding.md`](../../docs/internal/dogfooding.md).

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
2. An async `provision` is polled by the cron sweep against the `status` template until the mapped
   status reaches `ready` or `failed`; the handle's URL and access creds come off the `response`
   dot-paths, not off any fixed response shape.
3. The tester job's `test.environmentUrl` is wired straight from the persisted handle, so nothing
   downstream re-derives the address the environment was actually reached at.
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

A manifest describes your management API, and the single generic `HttpEnvironmentProvider`
interprets it: nothing about your endpoints is assumed. The site's
[Integration manifests](https://www.catfactory.ai/extend/manifests.html#environment-provider-manifest)
owns what the two manifests share (base URL, auth scheme, request templates, response mapping,
secrets referenced by key) and names the three operations. It stops above the field level, so the
schema, the worked example and the variable namespaces below are still authoritative here rather
than a second copy of that page; a website slice that lands them is what would let this section
become a pointer.

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
    // read from the provision response - distinct from the management-API auth):
    "access": { "scheme": "bearer", "tokenPath": "data.access_token" },
  },

  "defaultTtlMs": 3600000, // fallback TTL when no expiry returned
}
```

### Worked example: a PR-environment platform

Most preview-environment platforms expose three calls: "create an environment for
this PR", "get its status", "delete it", and key the environment on the PR's git
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
    "pathTemplate": "/projects/my-project/environments",
    "bodyTemplate": "{\"git_ref\":{\"pr_number\":{{input.pullNumber}}},\"github\":{\"owner\":\"{{input.repoOwner}}\",\"repo\":\"{{input.repoName}}\"}}",
  },
  // Status/teardown address the env by the ref captured from the provision response.
  "status": {
    "method": "GET",
    "pathTemplate": "/projects/my-project/environments/{{provision.externalId}}",
  },
  "teardown": {
    "method": "DELETE",
    "pathTemplate": "/projects/my-project/environments/{{provision.externalId}}",
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
  dot-path can't pull out cleanly, you have outgrown the manifest path: use the
  [code-adapter seam](#code-adapter-seam-when-the-manifest-isnt-enough).
- **Async provisioning.** If create returns before the environment is live, supply a
  `status` template; the cron sweep polls it until `statusMap` yields `ready` (or
  `failed`). A synchronous platform that returns a ready URL can omit `status`.

### Templating

- `{{input.*}}`: provision inputs. On a pipeline `deployer` step these are derived
  from the block (`blockId`, `title`, `type`, `description`, `features`) plus the
  **git/PR/repo context** below; on a manual provision they come from the request
  `inputs` (plus `blockId`). Explicit request `inputs` always win over the derived
  values.
- `{{provision.*}}`: fields captured from the provision response (`externalId`,
  `url`), available to `status`/`teardown`.
- Unknown references resolve to empty: a manifest can't reach arbitrary state.

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
owner/repo" request without any per-block configuration. Any identifier a
platform needs which is **not** derivable from the block (a project/team/tenant
slug, a target cluster) is not in this namespace: bake it into the manifest as a
literal in the `pathTemplate`/`bodyTemplate`, or pass it as a manual-provision
`input`. Register one manifest per such project if they differ.

### Auth schemes (calling the management API)

Why a manifest carries no secret VALUE is on the site's
[Integration manifests](https://www.catfactory.ai/extend/manifests.html) ("secrets are referenced,
never embedded"); what each scheme does with the key it references is here.

| `auth.type`                 | fields                                                                          | effect                                 |
| --------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| `none`                      | (none)                                                                          | no auth header                         |
| `api_key`                   | `headerName`, `secretRef`, `valuePrefix?`                                       | `headerName: <prefix><secret>`         |
| `bearer`                    | `secretRef`                                                                     | `Authorization: Bearer <secret>`       |
| `basic`                     | `usernameSecretRef`, `passwordSecretRef`                                        | `Authorization: Basic base64(u:p)`     |
| `oauth2_client_credentials` | `tokenUrl`, `clientIdSecretRef`, `clientSecretSecretRef`, `scope?`, `audience?` | POST token → `Authorization: Bearer …` |
| `custom_headers`            | `headers: [{ name, secretRef }]`                                                | each header set from its secret        |

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
  reaching an internal platform means widening the URL policy (next section).

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
