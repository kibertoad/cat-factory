# Infrastructure providers window — redesign (ephemeral environments + runner pool)

> **Status:** This documents the planned changes
> to the cat-factory SPA so the **ephemeral-environment window** and the **runner-pool
> registration** become **one tabbed "Infrastructure" surface** with a **real in-app
> manifest editor**, instead of two separate Integrations-Hub entries where the runner-pool
> one dead-ends on a "use the API" disclaimer.
>
> Companion docs: [`runner-pool-integration.md`](./runner-pool-integration.md) and
> [`environments-integration.md`](./environments-integration.md) (the two backend
> integrations this UI configures). The Kargo-side capability that makes "one pool serves
> both" possible upstream is tracked separately (the kargo repo's
> `docs/managed-container-runner.md`); **this doc is UI-only and backend-change-free.**

## Why

The two integrations are the same idea — "bring your own infra, described by a manifest +
write-only secrets" — split across two ports:

| Concern               | Port                                     | Local-mode toggle            | Backend routes                            |
| --------------------- | ---------------------------------------- | ---------------------------- | ----------------------------------------- |
| Run container agents  | `RunnerPoolProvider` → `RunnerTransport` | `delegateAgentsToRunnerPool` | `/workspaces/:ws/runner-pool/connection`  |
| Provision Tester envs | `EnvironmentProvider`                    | `delegateTestEnvToProvider`  | `/workspaces/:ws/environments/connection` |

Today they already share **one** component (`ProviderConnectionPanel.vue`), but surface as
**two** Integrations-Hub rows, and a **manifest-only** provider (no native code adapter)
has **no editor** — it falls through to a disclaimer telling the operator to use the API.
Net effect a user hit in practice: connecting an environment provider lit up "Provision
Tester environments…", but "Run container agents on the runner pool" stayed disabled
because **no runner pool can be registered from the UI at all**.

Two changes fix this:

1. **Merge** the two entries into one tabbed **Infrastructure** window (the same custom
   pool typically backs both jobs, so configuring them together reflects reality).
2. **Add a full manifest editor** so any manifest-driven provider (incl. a runner pool)
   can be registered, tested, and rotated entirely in-app.

Both decisions are locked (product call): **one tabbed window**, **full manifest editor —
not a disclaimer**.

## Current state (accurate anchors)

- **Two hub rows** — `frontend/app/app/components/layout/IntegrationsHub.vue` builds an
  "Infrastructure" section with an `environment` row and a `runner-pool` row, each calling
  `ui.openProviderConnection(kind)`.
- **One shared panel** — `frontend/app/app/components/settings/ProviderConnectionPanel.vue`
  is a single `UModal` parameterised by `ui.providerConnectionKind` (one kind at a time):
  - `canAuthor` (`:141`) = a **native** provider ships a `manifestTemplate` ⇒ render the
    **flat `describeConfig` field form** (`:436-512`), overlay onto the manifest on save
    (`buildManifestPayload`, `:172-195`).
  - `canRotateSecrets` (`:147`) = a manifest provider that's **already connected** ⇒
    secrets-only rotation form.
  - **else (manifest provider, not yet connected) ⇒ the disclaimer** (`:514-520`,
    i18n key `settings.providerConnection.manifestEditorUnavailable`). **This is the gap.**
  - **Delegation toggles** (`:294-361`) render only when `isLocal && kind==='environment'`
    (`showLocalDelegation`, `:71`); each toggle is disabled until its provider is
    registered (`runnerPoolRegistered`/`envRegistered`, `:73-74`). The runner-pool panel
    instead shows a hint pointing back to the env screen (`:363-380`).
- **Store** — `frontend/app/app/stores/providerConnections.ts`: `register` /
  `updateSecrets` / `test` / `remove`, keyed by kind; `descriptorFor` / `connectionFor` /
  `needingConfig`.
- **Composable** — `frontend/app/app/composables/api/providerConnections.ts` maps each kind
  to its contract set (describe / get / register / updateSecrets / test / unregister).
- **Types** — `frontend/app/app/types/providerConnections.ts`: `ProviderConnectionKind`,
  `ProviderDescriptor` (`kind: 'native' | 'manifest'`, `configFields`, `supportsTest`,
  `missingRequired`, optional `manifestTemplate`, optional `savedManifest`),
  `RegisterProviderInput { manifest, secrets }`, `TestProviderInput`.

## Proposed UX

### One tabbed Infrastructure window

- **Integrations Hub:** collapse the two rows into **one** "Infrastructure" entry (icon
  `i-lucide-server-cog`), showing a combined connected-state summary (e.g. "Agents: pool ·
  Envs: not connected"). Keep `isAvailable` gating (hide a tab whose backend integration is
  disabled / 503).
- **Window:** a single modal with **two tabs**:
  - **Container agents** → the runner-pool provider (connect/editor + logs).
  - **Test environments** → the environment provider (connect/editor + logs).
- **Delegation toggles** move to the **top of the window** (shown in local mode only),
  not buried in one tab — they're cross-cutting (each gated on its provider being
  registered, unchanged logic from `:73-74`). This removes the awkward
  `runnerPoolLocalHint` cross-link (`:363-380`) since both are now in one place.
- **Deep-linking:** `ui.openProviderConnection(kind)` stays the entry API but now selects
  the matching **tab** instead of choosing which standalone panel to mount. `ProviderConfigBanner`'s
  per-kind "Configure…" buttons open the window on the right tab.

### Full manifest editor (replaces the disclaimer)

For a **manifest-driven** provider (the common case for a runner pool, and for an
environment provider without a native adapter), the tab renders an **editor** instead of
the `:514-520` disclaimer:

- **A JSON manifest editor** (monospace `<UTextarea>` to start — no new heavy editor dep;
  a CodeMirror/Monaco upgrade is a later polish) seeded from
  `descriptor.savedManifest ?? a per-kind starter template` (see open question O1).
- **Inline validation:** parse on blur/typing; show parse errors and **shape errors**
  validated against the wire contract (runner-pool: `RunnerPoolManifest` in
  `@cat-factory/contracts` `runners.ts`; environment: the environment manifest schema) —
  the SAME Valibot schema the backend enforces, imported into the SPA so the operator gets
  immediate feedback. The **server remains authoritative** (register re-validates).
- **A secrets sub-form:** one password input per `secretRef.key` discovered in the manifest
  (e.g. `API_TOKEN`, OAuth `CLIENT_ID`/`CLIENT_SECRET`). Write-only — never prefilled;
  on an existing connection, an amber "re-enter to change" hint (reuse the
  `form.reenterSecrets` copy at `:450-461`).
- **Test / Save:** reuse `store.test` (sends `{ manifest, secrets }`) and `store.register`
  (`{ manifest, secrets }`) — **both store paths already exist and already accept a raw
  manifest**, so **no backend or store changes are needed** for save/test.
- **Native providers are unchanged:** when `descriptor.manifestTemplate` is present
  (`canAuthor`), keep the existing **flat field form** — it's friendlier than raw JSON. The
  manifest editor is the path for `kind:'manifest'` providers (and, optionally, an
  "advanced / edit raw manifest" toggle for native ones — open question O2).

### State matrix the editor must cover

| Provider                    | Connected? | Today                         | Proposed                                                                                 |
| --------------------------- | ---------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| native (`manifestTemplate`) | no         | flat connect form             | unchanged (flat form)                                                                    |
| native                      | yes        | flat update + secret re-enter | unchanged                                                                                |
| manifest                    | no         | **disclaimer (dead-end)**     | **manifest editor (author + secrets + test + save)**                                     |
| manifest                    | yes        | secrets-only rotation         | **manifest editor prefilled from `savedManifest`** (edit manifest AND/or rotate secrets) |

## What changes vs. stays

**Frontend changes (all in `@cat-factory/app`):**

- `IntegrationsHub.vue` — one Infrastructure entry instead of two.
- `ProviderConnectionPanel.vue` → becomes the **window shell with tabs**, or a new
  `InfrastructureWindow.vue` wrapping two `ProviderConnectionTab.vue` (one per kind). The
  existing flat-form + delegation logic is reused; the new piece is the editor branch.
- New `ProviderManifestEditor.vue` — the JSON editor + secrets sub-form + validation,
  emitting `{ manifest, secrets }` to the tab's test/save handlers.
- `ui` store — `providerConnectionKind` becomes the **active tab** (plus an `open` flag);
  `openProviderConnection(kind)` selects the tab.
- i18n catalog (`frontend/app/i18n/locales/en.json`) — see below.
- A patch changeset for `@cat-factory/app`.

**No change required:**

- `stores/providerConnections.ts`, `composables/api/providerConnections.ts`,
  `types/providerConnections.ts` — `register`/`test` already carry a raw `{ manifest,
secrets }`. (Types may gain a small `starterManifest` helper; see O1.)
- **Backend** — `register`/`test`/`describeProvider` already accept/return everything the
  editor needs (`savedManifest`, `kind`, `secretKeys`). The editor is a pure consumer.

## i18n (drift guards apply — see CLAUDE.md "Internationalization")

- **Remove:** `settings.providerConnection.manifestEditorUnavailable` (the disclaimer) and
  `settings.providerConnection.runnerPoolLocalHint` / `…ephemeralEnvironments` cross-link
  (obviated by tabs).
- **Add (namespace `settings.providerConnection.manifestEditor.*`):** `title`,
  `jsonLabel`, `jsonHelp`, `invalidJson`, `schemaError` (with a `{message}` placeholder),
  `secretsLabel`, `noSecrets`, `starterHint`.
- **Add (window/tabs, namespace `layout.integrationsHub.*` / `settings.providerConnection.tabs.*`):**
  `infrastructure.label`/`description` (the merged hub entry), `tabs.containerAgents`,
  `tabs.testEnvironments`.
- Keep straight quotes, no em-dashes, no raw display strings; annotate only genuinely
  ambiguous keys.

## Validation strategy

- **Client:** import the wire contract schema from `@cat-factory/contracts` (runner-pool
  `RunnerPoolManifest`, environment manifest) and run it on the parsed JSON to surface
  field-level errors before the network round-trip. This keeps the SPA's check in lockstep
  with the backend (single source of truth) per the i18n/contracts convention.
- **Server:** unchanged — `register` re-validates (Valibot) and is authoritative; a
  client that's behind still can't persist an invalid manifest.

## Non-goals / out of scope

- **No Kargo-specific code.** The `KargoRunnerPoolProvider` (warm long-lived runner +
  sticky router) is a separate wrapper-repo deliverable; this window just registers
  _whatever_ manifest the operator authors (including one fronting Kargo).
- **No backend changes.** If a future provider wants to ship a starter manifest from the
  server, that's an additive `describeProvider` field (O1), not part of this redesign.
- **No new editor dependency** in v1 (textarea + validation); a rich JSON editor is a
  follow-up.

## Open questions

- **O1 — starter manifest for a blank manifest-only provider.** Seed the editor from
  `savedManifest` when connected; when **not** connected there's nothing to seed. Options:
  (a) ship a small static per-kind example manifest in the SPA (fastest), or (b) add an
  optional `starterManifest` to the backend `ProviderDescriptor`. Recommendation: (a) for
  v1.
- **O2 — raw-manifest editing for native providers.** Should a native provider (flat form)
  also expose an "edit raw manifest" advanced mode? Recommendation: defer — the flat form
  is the intended UX for native adapters.
- **O3 — window component shape.** Extend `ProviderConnectionPanel.vue` into the tabbed
  shell, or introduce `InfrastructureWindow.vue` + per-kind tab child? Recommendation: new
  wrapper, keep each tab's body close to today's panel to minimise churn.

## Rollout

A single `@cat-factory/app` patch changeset; pure frontend, no migration. Add a
`data-testid` on the new manifest editor + tabs so the e2e suite can cover registering a
manifest-only runner pool (per the e2e "add the testid first" rule).
