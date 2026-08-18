# Initiative: GitLab product-surface parity (SPA)

**Status:** in progress (connect flow landed end to end; browse, bootstrap and every repo link are provider-aware; hosted runs now clone the GitLab host) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The GitLab **backend** is essentially complete: `@cat-factory/gitlab` implements the
neutral `VcsClient`/webhook/provisioning ports (`FetchGitLabClient`, constant-time webhook
verify, MR/check projection), self-registers via `registerVcsProvider('gitlab')`, and
`vcsBackedGitHubClient` adapts it behind the GitHub-shaped service layer so sync, pickers,
gates, and merge all work. Local mode is GitLab-capable end to end.

The **product surface is not**: GitLab appears in exactly ONE Vue component
(`components/auth/LoginScreen.vue`, as a PAT login option). There is no GitLab connect
flow, no repo/project browser, no "add service from GitLab project", and the ~10
`components/github/*` surfaces (onboarding, panel, repo search, tree browser) are
GitHub-only in copy and wiring. A GitLab deployment is configured by hand (env + `linkRepo`
CLI), which caps adoption of the provider the backend already supports. This is the
highest-leverage slice of the VCS strangler: the hard adapter work is done, what remains is
mostly frontend + the connect flow (`backend/docs/gitlab-parity.md` (a design doc, not a
tracker) names the per-workspace OAuth/PAT connect flow as the known future work).

End state: a GitLab user connects a workspace, browses projects, adds services, and runs
pipelines entirely through the UI, at feature parity with GitHub.

## Target pattern

- **Ride the existing GitHub-shaped stores**: this is the architecture's explicit design:
  `useGitHubStore` / `listGitHubAvailableRepos` already return GitLab projects through the
  adapter, and "there is no separate GitLab store; do not add one" (CLAUDE.md, VCS section).
  Parity work therefore means: (a) a connect flow that creates the GitLab connection rows
  the projection needs, (b) making the shared components provider-aware in _presentation_
  (labels, icons, URL shapes) while staying provider-neutral in _data_.
- **Provider-neutral vocabulary** everywhere new: `VcsProvider` / `VcsRepoRef` /
  `VcsConnectionRef` (`kernel/src/domain/vcs-types.ts`), never a new `github*`-named field
  (see "Git-provider-agnostic naming" in CLAUDE.md).
- **Connect flow**: per-workspace GitLab connect (PAT first; the mode the backend already
  supports; OAuth app flow as a later slice), persisting the connection and seeding the
  repo projection via the existing sync service, mirroring the GitHub connect shape in
  `GitHubConnect.vue` / `GitHubOnboarding.vue`.
- **Presentation switch, not component forks**: the repo-facing components read the
  provider off the connection/projection row and adapt labels ("Merge request" vs "Pull
  request", project paths, host) via i18n keys keyed on `VcsProvider` (exhaustive `Record`
  guard). Forking `GitHubPanel.vue` into a `GitLabPanel.vue` twin is the anti-pattern.

## Prioritized checklist

| #   | Slice                                                                                                                                                                                                                | Status  | PR      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| 1   | Audit pass: enumerate every GitHub-only affordance/copy in `components/github/*` + stores; classify neutral vs provider-keyed (write findings into this tracker)                                                     | ✅ done | #1138   |
| 1b  | **Provider pre-slice (gates all visual work):** add + populate a `provider: VcsProvider` discriminator on the repo/connection wire types + projections, symmetric across both runtimes, with a conformance assertion | ✅ done | this PR |
| 2a  | Per-workspace GitLab PAT connect flow; **backend** (persistence + connect service/controller + provider-routing client, both runtimes + conformance)                                                                 | ✅ done | this PR |
| 2b  | Per-workspace GitLab PAT connect flow; **connect UI** mirroring `GitHubConnect.vue` (provider-aware labels/icons, gitlab connection probe, i18n)                                                                     | ✅ done | this PR |
| 3   | Project browse / add-service-from-project through the shared store (provider-aware labels)                                                                                                                           | ✅ done | this PR |
| 4   | Webhook setup surface (register the GitLab webhook + secret for a connected project)                                                                                                                                 | ⬜ todo |         |
| 5   | Provider-keyed copy pass: PR/MR terminology, host/URL rendering, icons; i18n'd, all locales                                                                                                                          | ⬜ todo |         |
| 6   | Onboarding: provider choice step (GitHub App / GitHub PAT / GitLab PAT) in the connect onboarding                                                                                                                    | ⬜ todo |         |
| 7   | OAuth-based GitLab connect (the `gitlab-parity.md` future-work item)                                                                                                                                                 | ⬜ todo |         |
| 8   | e2e: GitLab-flavoured connect→add-service against a faked VCS boundary (MSW at the backend outbound boundary)                                                                                                        | ⬜ todo |         |
| 9   | **Hosted clone origin**: both hosted facades derive the agent container's clone host from `GITLAB_API_BASE` instead of falling through to `github.com`, plus the harness allow-list that makes it usable             | ✅ done | this PR |
| 10  | Per-workspace ENGINE routing: gate / merge / RepoFiles read the workspace's own connection rather than the single deployment token                                                                                   | ⬜ todo |         |

## Findings (slice 1 audit)

The audit confirmed the tracker's premise and surfaced one **blocking dependency** that
re-orders the remaining work: the SPA has nothing to switch presentation on yet, and the
connect surface is modelled entirely on GitHub-App semantics that GitLab does not have. Read
this before picking up slice 2.

### The blocking dependency: no `provider` on the data, GitLab is deployment-level

- **No wire type carries a `provider` discriminator.** `GitHubConnection`, `GitHubRepo`,
  `GitHubAvailableRepo`, `GitHubPullRequest`, `GitHubIssue`, `GitHubBranch`
  (`backend/packages/contracts/src/github.ts`) are all GitHub-shaped and keyed on numeric
  ids (`githubId`, `repoGithubId`, `installationId`). `VcsProvider`
  (`kernel/src/domain/vcs-types.ts`) is **unused in the frontend**: the only provider-typed
  frontend import is `VcsProviderWire` in `composables/api/auth.ts` (the PAT-login signature).
  **Consequence:** the tracker's "read the provider off the connection/projection row"
  (slices 3 & 5) is blocked until a `provider: VcsProvider` field is added to the repo /
  connection wire types and populated. That field addition is the real first code slice, and
  it must land symmetrically across both runtimes (D1 mappers + Drizzle mappers +
  `github_repos`/`github_installations` projections) with a conformance assertion: see "Keep
  the runtimes symmetric" in CLAUDE.md.
- **GitLab has no per-workspace connection today.** The backend GitLab provider is
  **deployment-level**: one `GITLAB_TOKEN` (`backend/packages/gitlab`, registered via
  `registerVcsProvider('gitlab')`; wired in each facade's `container.ts` when
  `config.gitlab.enabled`). There is **no `GitLabController`, no per-workspace GitLab
  connection table, and no available-repos listing keyed to a per-workspace GitLab PAT.**
  `gitlab-parity.md` lists the per-workspace connect flow as explicitly deferred future work
  (accepted gap). **Consequence:** slice 2 is not "add a connect UI": it is a
  persistence-and-controller design decision (store a per-workspace GitLab PAT (likely by
  generalising `github_installations`, or a new neutral `vcs_connections` table) then seed
  the projection through `GitHubSyncService`, mirroring local mode's `linkRepo.ts` +
  `createLocalGitLabClient` + `AutoProvisioningInstallationRepository` at the per-workspace
  level). This is the initiative's largest slice and gates 3, 4, 6, 7, 8.
- **The connect model is GitHub-App-installation-shaped.** `GitHubConnect.vue` /
  `GitHubOnboarding.vue` are built entirely around App installations (`installationId`,
  `targetType: Organization|User`, the install-redirect to `github.com/apps/<slug>/…`, and a
  manual installation-id entry). None of these concepts exist for a GitLab PAT connect. The
  connect UI is therefore a genuine new surface (mirroring the _shape_, not the App
  vocabulary), not a copy-tweak of the GitHub component.

### Surface inventory & classification

Everything below lives under `frontend/app/app/`. All copy already routes through i18n
(`t('github.*')` in `frontend/app/i18n/locales/en.json`, namespaces
`github.{onboarding,connect,panel,addService,repoTree}`), so the copy work is catalog +
provider-keyed lookups, not string extraction. There is exactly **one** VCS store,
`stores/github.ts` (`useGitHubStore`): the "do not add a GitLab store" rule holds.

**Provider-KEYED (presentation must switch on `VcsProvider`):**

- **Host / URL builders**: `stores/github.ts` `repoUrl` / `pullUrl` / `issueUrl` hardcode
  `https://github.com/{owner}/{name}` + `/pull/{n}` + `/issues/{n}`. GitLab needs the
  connection host and `/-/merge_requests/{n}` + `/-/issues/{n}` + group/project paths.
- **Install-management URLs**: `AddServiceFromRepoModal.vue` `manageInstallUrl` hardcodes
  `github.com/settings/installations/…` and `github.com/organizations/…/settings/…`.
- **PR vs MR terminology**: pervasive across `github.panel.*` ("Open PR", "Merge pull
  request", state `merged`) and the hardcoded `"GitHub"` `UModal`/`IntegrationBackTitle`
  title in `GitHubPanel.vue`. Provider-keyed i18n lookups (tier-2 exhaustive
  `Record<VcsProvider, …>`), never ternaries with raw strings.
- **Icons**: `i-lucide-github` is hardcoded across every `components/github/*` component;
  `i-lucide-gitlab` exists only in `LoginScreen.vue` today. Needs a provider→icon map.
- **Connect vocabulary**: `github.connect.*` / `github.onboarding.*` ("Install GitHub App",
  "Your installations", "Installation ID", "Connect cat-factory to GitHub") is App-specific
  and does not translate to a GitLab PAT connect.

**Provider-NEUTRAL (no change needed for parity, data already generic in shape):**

- Repo tree browser (`RepoTreeBrowser.vue`, `github.repoTree.*`), the repo search combobox
  (`GitHubRepoSearchSelect.vue`) + empty state (`RepoSearchEmpty.vue`), branch listing, and
  the `owner/name` label rendering: all operate on already-generic projection data
  (`RepoTreeEntry`, `GitHubAvailableRepo`), so they only inherit the label/icon switch above.
- The single store keyed on `repoGithubId` is reused as-is (projection tables stay
  GitHub-named on purpose: see gotchas).

**Already provider-aware (the reference pattern to copy):** `LoginScreen.vue` + `stores/auth.ts`
already switch on `('github'|'gitlab')`: provider labels, `i-lucide-{github,gitlab}` icons,
per-provider token-creation URLs, and a provider toggle when more than one PAT provider is
configured. The auth-config response exposes configured providers
(`patLogin.providers`, `vcsProviderSchema`). This is the shape slices 5/6 should mirror,
lifted from local inline constants into i18n + a shared provider descriptor.

### Recommended slice re-ordering for follow-up PRs

Given the blocking dependency, the productive order is: **(a) add + populate a `provider`
discriminator on the repo/connection wire types across both runtimes (new pre-slice, gates
everything visual)** → then slice 2 (per-workspace GitLab connection persistence + connect
controller) → slice 3 (project browse) → slice 5 (provider-keyed copy, now that the data
carries `provider`) → slices 4/6/7/8. Slice 5's copy work can be catalog-scaffolded in
parallel but stays inert until the `provider` field is on the data.

**Update: pre-slice (a) is DONE (slice 1b, this PR).** `provider: VcsProvider` is now on
`GitHubRepo` / `GitHubConnection` / `GitHubAvailableRepo` (contracts) and kernel
`GitHubInstallation`, persisted on `github_repos` + `github_installations` (D1 migration
`0051_vcs_provider.sql` + a Drizzle migration + both mappers), and asserted by
`defineVcsProviderSuite` on both runtimes. The value is a per-connection fact: the connection
records it (GitHub-App connect → `github`; local `AutoProvisioningInstallationRepository` →
the deployment provider, `gitlab` for a GitLab-PAT deployment) and repos inherit it via the
sync service (`installation.provider`), bootstrapper, and CLI `linkRepo`. Legacy rows default
to `github`. **The SPA still reads nothing off it yet**: slices 3 & 5 are now unblocked to
switch presentation on `repo.provider` / `connection.provider` (fall back to `'github'` when
absent). Note the hosted GitLab facades (CF/Node) don't write these projection tables at all
(GitLab ingests via the neutral `/vcs/:provider/webhooks` route), so a persisted `gitlab`
provider only appears in local GitLab mode today; the wire field is what slices 2+ populate
for the hosted connect flow.

## Findings (slice 2a: backend connect flow)

Slice 2a landed the backend of the per-workspace GitLab PAT connect. Read this before slice 2b
(the UI) or slice 3 (project browse).

- **Persistence generalises `github_installations`, no new table.** The connection record is
  already one-per-workspace and carries `provider`, so a GitLab connection is just a row with
  `provider: 'gitlab'` + a new sealed **`access_token`** column (nullable; the App path mints its
  own tokens and leaves it null). D1 migration `0060_gitlab_pat_token.sql` ⇄ a Drizzle migration
  ⇄ both mappers ⇄ the `defineVcsProviderSuite` round-trip assertion. The installation id is
  synthesised from the workspace id (`syntheticInstallationId`, WebCrypto SHA-1, runtime-neutral:
  matches local mode's byte-for-byte), so it round-trips through `connectionId = String(id)`.
- **`VcsPatConnectionService`** (`@cat-factory/integrations`, provider-neutral) validates a pasted
  PAT via the `VcsIdentityResolver` (a bad token → `ValidationError`), seals it with the
  deployment `SecretCipher` (`cat-factory:vcs-token` domain), and writes the row (`accountId: null`:
  a per-workspace token, never account-shared). `StoredGitLabTokenSource` (`@cat-factory/gitlab`)
  reads + decrypts it per call; `buildGitLabConnectClient` bridges a `FetchGitLabClient` over it to
  the `GitHubClient` port, so the whole `GitHubSyncService` seed path works unchanged for GitLab.
- **Provider routing = `providerRoutingGitHubClient`** (`@cat-factory/server`). When BOTH a GitHub
  App and GitLab connect are configured, the `github` module reads through a router that dispatches
  each installation-keyed call to the App or GitLab client by the connection's stored provider
  (memoised per installation: an immutable identity, so no N+1 in the sync loops). It is a `Proxy`,
  so the surface it presents is the UNION of what the configured backing clients implement: every
  required method plus every optional one at least one client has. An optional method the routed
  provider lacks refuses by name (`VcsCapabilityUnsupportedError`) rather than resolving to
  `undefined`, because "this deployment wired no such capability" and "this provider does not offer
  it" need different fixes. An earlier hand-written delegate forwarded the required methods and two
  optionals only, which reported a capability the deployment HAD as absent; see the module header
  for what that cost. The GitHub-issue/docs consumers still keep the raw App client (they must not
  gain the GitLab fallback), so they never reach the router at all.
- **Wiring is symmetric.** Both facades relax the `github` module gate to build when EITHER the App
  OR GitLab connect is enabled (`selectVcsConnectDeps` in Node's `container-github-deps.ts`,
  `selectWorkerVcsConnectDeps` in the Worker's `vcsConnect.ts`), feeding the module the router /
  App / GitLab client as configured. `vcsConnectionService` is a `CoreDependencies` field exposed
  on `Core`, so it flows onto the ServerContainer through `createCore` on both facades. Controller:
  `GitLabController` (`GET|POST|DELETE /workspaces/:ws/gitlab/connection`), 503 until wired.
- **Scope boundary carried to a follow-up:** the connect flow enables repo **browse / link / sync**
  per-workspace (the router serves the `github` module). The **engine's gate/merge + RepoFiles**
  path still reads through the single-token `engineVcsClient` (`buildGitLabEngineClient` off
  `GITLAB_TOKEN`), NOT the per-workspace client, so per-workspace engine routing is a deliberate
  later slice, and the connect feature is currently gated on a deployment `GITLAB_TOKEN` being set
  (`config.gitlab.enabled`) plus a sealing key. Note this when picking up slice 3+.

## Findings (slice 2b: connect UI)

Slice 2b put the connect flow in front of users. Read this before slice 3 (project browse) or
slice 5 (the copy pass): it establishes where provider presentation is decided.

- **A capability route, because the connection reads can't answer "what can I connect?".** Since
  2a the `github` module builds for EITHER provider, so a 200 from `GET /github/connection` says
  nothing about whether an App is installable: a GitLab-only deployment would have rendered the
  App installation picker (and then failed listing installations). The single signal is now
  `GET /workspaces/:ws/vcs/connect-options` (`VcsConnectController`, `@cat-factory/server`,
  `integrations.manage`), returning `{ provider, method }` pairs derived from what the facade
  actually wired: `config.github.enabled && container.github` ⇒ `github/app`, a wired
  `vcsConnectionService` ⇒ `<its provider>/pat`. It reports CAPABILITY only: the workspace's
  current connection (and its `provider`) still comes from `GET /github/connection`. Pure shared
  HTTP layer over container fields, so it is runtime-symmetric with no per-facade wiring.
- **No GitLab store, and no forked components** (the target pattern held). The store additions
  live on `useGitHubStore`: `connectOptions` (resolved by the same single-flight probe, in
  parallel with the connection read and degrading to `[]` on its own), the derived
  `canConnectGitHubApp` / `canConnectGitLabPat` / `soleConnectProvider`, `provider` (the connected
  provider, defaulting to `github`), and `connectGitLab(pat)`. `disconnect()` now dispatches
  through an exhaustive `Record<VcsProvider, …>` so a GitLab connection is never torn down via the
  GitHub route.
- **`components/vcs/GitLabConnect.vue` is a new surface, not a copy**: GitLab has nothing to
  discover and nowhere to redirect, so it is a PAT field + the `api`-scope hint + a token-creation
  link, with the upstream validation error shown inline (it says WHY the token was rejected, which
  a generic toast would flatten). `GitHubPanel.vue` and `GitHubOnboarding.vue` render each connect
  surface only where the deployment serves it, and say so when it serves none.
- **Where presentation switches: `app/utils/vcs.ts`.** Brand labels / icons / token-creation URLs
  are exhaustive `Record<VcsProvider, …>` constants (brand names stay verbatim in every locale, so
  they are constants, not catalog keys; the convention `LoginScreen.vue` already used, now lifted
  out of it and shared). PROSE is provider-parameterised i18n under the new `vcs.*` namespace
  (`{provider}` placeholders), which is the shape slice 5 should extend rather than replace: the
  App-specific `github.onboarding.title`/`intro` and `github.panel.confirmDisconnect` /
  `toast.disconnected` keys are GONE, replaced by `vcs.onboarding.*` / `vcs.panel.*` (all 10
  locales). `github.onboarding.appIntro` is what remains GitHub-App-specific.
- **Still GitHub-hardcoded, and still slice 3/5's job:** `stores/github.ts`'s `repoUrl` /
  `pullUrl` / `issueUrl` builders and `AddServiceFromRepoModal.vue`'s `manageInstallUrl`. They now
  have `github.provider` to switch on: the data is no longer the blocker, only the work is.
  (`manageInstallUrl` was settled by slice 3 below; the URL builders remain slice 5's.)

## Findings (slice 3: browse + add-service)

Slice 3 made the two surfaces that stand between a connected workspace and a running pipeline
provider-aware: add-service-from-repo and bootstrap. Read this before slice 4 or 5.

- **The connect fan-out is ONE component now (`components/vcs/VcsConnectSurfaces.vue`).** Slice 2b
  taught the panel and the onboarding gate to render only the connect methods the deployment
  serves, but the two MODALS that also strand a user on "not connected" (add-service, bootstrap)
  each hardcoded `<GitHubConnect />`. On a GitLab-only deployment both offered an App
  installation flow the deployment cannot serve, with no way to connect from where the user
  actually was. The fan-out was already duplicated twice, so a third and fourth copy was the
  wrong answer; every surface takes the shared component and passes only the App-path intro copy.
- **What is App-only is now stated by the CONNECTION, not inferred from the provider.**
  `GitHubConnection.method` (`app` | `pat`, the `VcsConnectMethod` vocabulary `connect-options`
  already used) is required on the wire, and the App-only affordances key off it: the
  installation settings page behind "grant the App access", which both modals previously built
  from `connection.installationId` unconditionally. A provider test would have looked right and
  still been wrong twice over: a GitHub PAT connect is a supported shape of
  `VcsPatConnectionService`, and LOCAL mode's synthetic connection is `provider: 'github'` and
  PAT-backed, so it was being handed a `github.com/settings/installations/<synthetic-id>` link
  that 404s. That local bug predates GitLab and is fixed here too.
- **`method` is DERIVED from the row, in the one mapper that reads back all three writers.**
  `GitHubInstallationService.getConnection` serves rows written by its own App connect, by the
  PAT connect, and by local mode's auto-provisioner, so it cannot assert a method. The
  discriminator is `appId`: only the App connect path fills it (probed at connect to route token
  mints, ADR 0005) and both PAT paths leave it null. A row predating the multi-App tier also has
  none and therefore reads as `pat`, losing one convenience link until it reconnects; that is the
  "let stale internal state be re-created" disposition, not a shim. Pinned by
  `GitHubInstallationService.connectMethod.test.ts` (all three writers) plus the connect-response
  and read assertions in both facades' specs.
- **`method` is REQUIRED on the wire, and the absent case is not a supported state.** It is the
  one field in `githubConnectionSchema` that is, and the contrast with `provider` beside it (which
  is `v.optional` with a "backends predating the column" note) is worth stating once: an optional
  `method` would be exactly the internal-compatibility fallback the repo rules forbid, and it
  would leave both `toConnection` mappers free to forget the field. Required means a response
  without it fails the SPA's contract validation, which is the honest outcome: no client can
  decide what to offer from a value it never received. Readers still ask `=== 'app'`, so anything
  that is not an App installation withholds the App affordances. Do not "harden" this by
  defaulting an absent `method` at a call site.
- **Copy moved to `vcs.addService.*` / `vcs.bootstrap.*`**, provider-parameterised, extending the
  namespace slice 2b opened. The repository hint is now a PAIR of keys rather than one
  parameterised string, because the two cases give different remedies: an App connection sends you
  to the grant-access page, a token connection to the token's own scope and your project
  membership. Which of the two renders is asked of `connection.method`, NOT of whether the
  manage-installation URL could be built: those coincide today, but an App install whose settings
  page we could not name (a future Enterprise host) would otherwise be told to go check its
  token's scope. Three add-service keys no component had referenced (`noReposAvailable`,
  `refreshList`, `showingCount`) went with them.
- **Bootstrap's own paragraphs moved too, and the intro is THREE keys because it makes three
  different promises.** `bootstrap.intro.canCreate` / `manual` said "Create an empty GitHub
  repository" unconditionally, and `bootstrap.arch.pickRepo.label` said "Pick an existing GitHub
  repo": the same bug this slice fixed one modal over, in the modal it was already editing. They
  are now `vcs.bootstrap.introCanCreate` / `introManual` / `introManualAny` and
  `vcs.bootstrap.archPickRepo`. The split is not decoration: cat-factory creating the repo, the
  user creating it in one click, and the user creating it somewhere we cannot name are three
  different instructions, and the third must not promise a button that (per the next point) is
  absent. All three key off the SAME value the button does, so the copy and the affordance cannot
  disagree.
- **Copy rendered BEFORE a connection exists must not read `provider`.** It answers "what is
  connected" and so defaults to `github`, which is right for the surfaces slice 2b touched (all
  behind a connection) and wrong for an intro paragraph or a create-repo button that renders
  while the connect box is still on screen: a GitLab-only deployment was offered "Pick an
  existing GitHub repository". The store now derives `surfaceProvider` (connected provider, else
  the sole connectable one, else null) and the panel's inline `chromeProvider` was already that
  computation, so it adopts it. Null is a real case (several connectable, none bound) and gets
  neutral copy (`vcs.addService.introAny`, the `vcs.onboarding.titleAny` pattern) rather than a
  guessed brand; bootstrap's manual create-repo button HIDES there instead, since with no host
  resolved there is no page to open. The derived provider questions moved beside the connect
  actions in `stores/github/vcsConnect.ts` (`createVcsProviderViews`), which is also what kept
  the store's setup under `max-lines-per-function`.
- **An un-nameable host WITHHOLDS its link rather than guessing at gitlab.com.** `newRepoUrl`
  (`~/utils/vcs`) answers `undefined` for GitLab, and the bootstrap modal's manual create-repo
  button and copy both drop out, exactly as they already did for an unresolved provider. The
  tempting alternative (`https://gitlab.com/projects/new`, following what slice 2b accepted for
  the token link) fails differently from a dead link and worse: it looks like it worked, so a
  self-hosted user creates the project on a server the bootstrap run will never push to, and
  discovers it as a failed run. gitlab.com users lose a convenience they never had working (the
  button previously opened `github.com/new`), and slice 5 hands it back the moment a host exists.
  The `NEW_REPO_PAGES` map is `Record<VcsProvider, string | null>` so a new provider still has to
  state its answer rather than inheriting one.
- **What slice 5 still owns.** `stores/github.ts`'s `repoUrl` / `pullUrl` / `issueUrl` are
  untouched: they need a HOST the SPA does not have, which is the real remaining question.
  **`VCS_PROVIDER_TOKEN_URLS` still assumes `gitlab.com`** and is wrong for a self-hosted
  instance; it stays because a wrong token link is a nuisance during connect where a wrong
  new-project link costs a run, so the two got different dispositions here. Once a web base URL
  lands, slice 5 fixes the token link AND restores the new-repo one from the same value. The
  obvious carrier is the connection (a host is a per-connection fact, like `provider` and
  `method`), derived from `config.gitlab.apiBase` with its `/api/v4` suffix stripped; a
  repo-projection column would make it a per-repo fact it is not.
  **Update: slice 5 (below) took exactly that carrier**, and put the same value on the connect
  OPTION so the pre-connection surfaces have it too.

## Findings (slice 5: the host, and the vocabulary that hangs off it)

Slice 5 answered the question slices 3 and 4 kept deferring: WHERE a repo actually lives. Read
this before slice 4 (webhook setup) or 6 (the onboarding provider choice).

- **The host is a per-CONNECTION fact, DERIVED from the API base, and it is `null` when it does
  not invert.** `webUrl` is now required on `GitHubConnection` and on each `VcsConnectOption`,
  resolved once by `resolveVcsWebUrls(config)` (`@cat-factory/server`) off kernel's
  `vcsWebBaseUrl`: `/api/v3` and `/api/v4` are stripped, `api.github.com` maps to `github.com`,
  and a relative-URL install keeps its prefix (`https://host/gitlab/api/v4` →
  `https://host/gitlab`). A SECOND config variable was the obvious alternative and was rejected:
  every deployment that has a web host already told us its API base, and a second variable is a
  second thing to get wrong on exactly the deployments (self-managed) this slice exists for.
- **It rides the connect OPTION as well as the connection, and that is not redundancy.** The two
  surfaces that most need a host render BEFORE anything is bound: the PAT box's "create a token"
  link and bootstrap's "create a repository" button. Reading a connection there is impossible,
  which is precisely how slice 3 ended up withholding GitLab's new-project button entirely.
- **Only the TOKEN link may fall back to the provider's public instance.** Every other builder
  withholds. The two failures are not the same size: a settings page on the wrong host costs a
  click and is noticed immediately, while a repo/project link on the wrong host resolves to a
  real page belonging to somebody else, and a project CREATED there looks like success until the
  bootstrap push cannot find it. `~/utils/vcs` states that split at each builder rather than
  leaving it to call sites.
- **`appInstallationManageUrl` now withholds on an un-nameable host too.** An installation id
  means nothing on an instance other than its own, so a GitHub Enterprise connection whose host
  we cannot name gets no grant-access link rather than a github.com one.
- **The PROVIDER comes off the repo row, the HOST off the connection.** `repoUrl`/`pullUrl`/
  `issueUrl`/`branchUrl` read `repo.provider` for the path shape (`/-/merge_requests/` vs
  `/pull/`) and `connection.webUrl` for the origin. Asking the connection for both would be
  wrong the moment a row predating the discriminator sits under a GitLab connection. The
  inspector's branch link lost its old fallback (slicing `/pull/<n>` off the PR url), which
  silently yields nothing on a merge-request url and would have needed a second provider guess
  to repair.
- **Terminology is provider-keyed only where a provider's DATA is on screen.** The source-control
  panel lists one connection's merge/pull requests, so its eight PR nouns moved to
  `vcs.panel.pulls.{github,gitlab}.*`, resolved through an exhaustive `Record` of STATIC catalog
  keys. The platform's own vocabulary elsewhere (risk policies, gate subtitles, the merge
  effort prompt) stays as it is: it describes what cat-factory does, not what a host calls it,
  and provider-keying all 130 of those strings would buy nothing a GitLab user notices. What DID
  change there is the handful that named GitHub while describing whichever host the workspace is
  on ("Open {pr} on GitHub", "View pull request on GitHub", the `github_not_connected` remedy):
  those are now neutral, not provider-keyed, because the surfaces rendering them have no
  connection in hand.
- **Two repo-picker strings turned out to be METHOD-keyed, not provider-keyed.** "The
  installation can't access any repositories yet" and "the connection is shared across the
  account" are true of a GitHub App and false of any pasted token, GitHub PATs and local mode's
  synthetic connection included. They key off `connection.method`, the same discriminator slice 3
  introduced for the grant-access link.
- **What is still GitHub-shaped, deliberately:** `github.panel.connectIntro` and
  `github.onboarding.appIntro` describe the App install flow and render only above the App
  picker. Local mode's `patCreationUrl` helpers still hard-code gitlab.com; they serve the
  sign-in screen, which has no workspace and therefore no host, and they are the fallback case
  the token-link rule above already accepts.

## Conventions & gotchas

- **Never re-hardcode GitHub** (or GitLab): hosts come from `ResolveRepoOrigin`, identity
  fields are `repoId`/`connectionId`/`provider`. A new persisted or wire type with a
  `github*` name is a review-blocker.
- **The GitHub-issue-specific consumers must NOT gain the GitLab fallback**: keep
  `engineVcsClient` vs App-only `githubClient` distinct (a GitLab deployment must not
  offer a dead "GitHub Issues" source).
- **Terminology is a locale problem**: "Pull request"/"Merge request" and similar strings
  are provider-keyed i18n lookups (tier-2 exhaustive `Record` on `VcsProvider`), not
  ternaries with raw strings.
- The projection tables are still GitHub-named (`github_repos`/`github_installations`) and
  intentionally reused as-is: do not block UI parity on renaming them (that fold is the
  separate, acknowledged Phase-1 entity-naming work).

## Findings (slice 9: where a hosted GitLab run actually clones from)

Slice 9 came out of a parity sweep rather than the checklist, and it is worth reading before slice
10 (per-workspace engine routing), because it settles what a deployment-level provider fact is and
where it is derived.

- **`ResolveRepoOrigin` was wired by local mode ALONE, and the default is `github.com`.** The seam
  exists precisely so a GitLab deployment's containers clone the right host, and both hosted facades
  passed nothing, so every dispatch fell through to `githubRepoOrigin` with `provider: 'github'`. A
  GitLab-only Node or Worker deployment gated on real GitLab CI and merged real merge requests while
  handing each agent a `https://github.com/<group>/<project>.git` URL. The failure is a run that
  cannot check out, on a deployment whose source control is visibly working everywhere else, which
  is why the parity log's item 1 ("wire GitLab into the Node + Cloudflare gate/merge/sync paths")
  read as complete: the CLONE path is not one of the three.
- **A correct URL alone would still have been refused.** The harness only sends a clone credential
  to a host on `allowedGithubHosts`, which defaults to github.com and is widened by
  `GITHUB_ALLOWED_HOSTS`. Local mode set it (`harnessAllowedHosts`); neither hosted facade did.
  Fixing one half without the other turns a wrong-host checkout into a security refusal, so
  `deploymentRepoOrigin` and `harnessGitLabHost` are declared together in one module that says why.
- **Both are DERIVED from `GITLAB_API_BASE` through `vcsWebBaseUrl`**, the same inversion the SPA's
  repo/MR/issue links use. A second config variable was the obvious alternative and loses the same
  way it lost in slice 5: it is a second thing to get wrong on exactly the self-managed deployments
  this exists for, and it lets the host a container clones drift from the host a user is shown.
  Deriving it also handed local mode a bug fix, since its own `new URL(apiBase).host` dropped the
  path prefix of a relative-URL install.
- **A base that does not invert THROWS at dispatch**, where every other consumer of this derivation
  withholds. The disposition differs because the failure does: a withheld LINK is a missing
  affordance, while a fallback CHECKOUT resolves to a real project on the public instance belonging
  to somebody else, and the run reports whatever it found there as its repository. There is nothing
  to withhold on a clone path, so the only honest options are the right host or a named refusal.
  The allow-list half still answers `undefined` for the same base, because allow-listing gitlab.com
  for a deployment that does not use it is a widening with no purpose.
- **The rule is `engineVcsClient`'s, restated: the App wins wherever both are configured.** The
  client that opens the request and the URL the container clones must name one host, and this seam
  takes no workspace, so it could not answer per workspace even if it wanted to. That is what makes
  it slice 10's problem rather than a special case here.
- **Slice 10's shape is now visible in three places, not one.** The engine's gate/merge client, the
  clone origin, and `makeResolveRepoFilesForCoords` (the environments module's block-less repo
  resolver, fixed in this PR to resolve a GitLab repo rather than refuse every caller that named
  one) all bind ONE deployment-level client. Each is correct for a single-provider deployment and
  wrong for a mixed one in the same way. Whatever routes the first should route all three, and a
  fix that only reaches the gate client will leave two silent halves behind.
