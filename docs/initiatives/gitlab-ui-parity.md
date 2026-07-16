# Initiative: GitLab product-surface parity (SPA)

**Status:** in progress (slice 1 audit landed) · **Owner:** core · **Started:** 2026-07-16

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
mostly frontend + the connect flow (`backend/docs/gitlab-parity.md` — a design doc, not a
tracker — names the per-workspace OAuth/PAT connect flow as the known future work).

End state: a GitLab user connects a workspace, browses projects, adds services, and runs
pipelines entirely through the UI, at feature parity with GitHub.

## Target pattern

- **Ride the existing GitHub-shaped stores** — this is the architecture's explicit design:
  `useGitHubStore` / `listGitHubAvailableRepos` already return GitLab projects through the
  adapter, and "there is no separate GitLab store; do not add one" (CLAUDE.md, VCS section).
  Parity work therefore means: (a) a connect flow that creates the GitLab connection rows
  the projection needs, (b) making the shared components provider-aware in _presentation_
  (labels, icons, URL shapes) while staying provider-neutral in _data_.
- **Provider-neutral vocabulary** everywhere new: `VcsProvider` / `VcsRepoRef` /
  `VcsConnectionRef` (`kernel/src/domain/vcs-types.ts`) — never a new `github*`-named field
  (see "Git-provider-agnostic naming" in CLAUDE.md).
- **Connect flow**: per-workspace GitLab connect (PAT first — the mode the backend already
  supports; OAuth app flow as a later slice), persisting the connection and seeding the
  repo projection via the existing sync service, mirroring the GitHub connect shape in
  `GitHubConnect.vue` / `GitHubOnboarding.vue`.
- **Presentation switch, not component forks**: the repo-facing components read the
  provider off the connection/projection row and adapt labels ("Merge request" vs "Pull
  request", project paths, host) via i18n keys keyed on `VcsProvider` (exhaustive `Record`
  guard). Forking `GitHubPanel.vue` into a `GitLabPanel.vue` twin is the anti-pattern.

## Prioritized checklist

| #   | Slice                                                                                                                                                            | Status  | PR      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| 1   | Audit pass: enumerate every GitHub-only affordance/copy in `components/github/*` + stores; classify neutral vs provider-keyed (write findings into this tracker) | ✅ done | this PR |
| 2   | Per-workspace GitLab PAT connect flow (backend rows + connect UI mirroring `GitHubConnect.vue`)                                                                  | ⬜ todo |         |
| 3   | Project browse / add-service-from-project through the shared store (provider-aware labels)                                                                       | ⬜ todo |         |
| 4   | Webhook setup surface (register the GitLab webhook + secret for a connected project)                                                                             | ⬜ todo |         |
| 5   | Provider-keyed copy pass: PR/MR terminology, host/URL rendering, icons — i18n'd, all locales                                                                     | ⬜ todo |         |
| 6   | Onboarding: provider choice step (GitHub App / GitHub PAT / GitLab PAT) in the connect onboarding                                                                | ⬜ todo |         |
| 7   | OAuth-based GitLab connect (the `gitlab-parity.md` future-work item)                                                                                             | ⬜ todo |         |
| 8   | e2e: GitLab-flavoured connect→add-service against a faked VCS boundary (MSW at the backend outbound boundary)                                                    | ⬜ todo |         |

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
  (`kernel/src/domain/vcs-types.ts`) is **unused in the frontend** — the only provider-typed
  frontend import is `VcsProviderWire` in `composables/api/auth.ts` (the PAT-login signature).
  **Consequence:** the tracker's "read the provider off the connection/projection row"
  (slices 3 & 5) is blocked until a `provider: VcsProvider` field is added to the repo /
  connection wire types and populated. That field addition is the real first code slice, and
  it must land symmetrically across both runtimes (D1 mappers + Drizzle mappers +
  `github_repos`/`github_installations` projections) with a conformance assertion — see "Keep
  the runtimes symmetric" in CLAUDE.md.
- **GitLab has no per-workspace connection today.** The backend GitLab provider is
  **deployment-level**: one `GITLAB_TOKEN` (`backend/packages/gitlab`, registered via
  `registerVcsProvider('gitlab')`; wired in each facade's `container.ts` when
  `config.gitlab.enabled`). There is **no `GitLabController`, no per-workspace GitLab
  connection table, and no available-repos listing keyed to a per-workspace GitLab PAT.**
  `gitlab-parity.md` lists the per-workspace connect flow as explicitly deferred future work
  (accepted gap). **Consequence:** slice 2 is not "add a connect UI" — it is a
  persistence-and-controller design decision (store a per-workspace GitLab PAT — likely by
  generalising `github_installations`, or a new neutral `vcs_connections` table — then seed
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
`stores/github.ts` (`useGitHubStore`) — the "do not add a GitLab store" rule holds.

**Provider-KEYED (presentation must switch on `VcsProvider`):**

- **Host / URL builders** — `stores/github.ts` `repoUrl` / `pullUrl` / `issueUrl` hardcode
  `https://github.com/{owner}/{name}` + `/pull/{n}` + `/issues/{n}`. GitLab needs the
  connection host and `/-/merge_requests/{n}` + `/-/issues/{n}` + group/project paths.
- **Install-management URLs** — `AddServiceFromRepoModal.vue` `manageInstallUrl` hardcodes
  `github.com/settings/installations/…` and `github.com/organizations/…/settings/…`.
- **PR vs MR terminology** — pervasive across `github.panel.*` ("Open PR", "Merge pull
  request", state `merged`) and the hardcoded `"GitHub"` `UModal`/`IntegrationBackTitle`
  title in `GitHubPanel.vue`. Provider-keyed i18n lookups (tier-2 exhaustive
  `Record<VcsProvider, …>`), never ternaries with raw strings.
- **Icons** — `i-lucide-github` is hardcoded across every `components/github/*` component;
  `i-lucide-gitlab` exists only in `LoginScreen.vue` today. Needs a provider→icon map.
- **Connect vocabulary** — `github.connect.*` / `github.onboarding.*` ("Install GitHub App",
  "Your installations", "Installation ID", "Connect cat-factory to GitHub") is App-specific
  and does not translate to a GitLab PAT connect.

**Provider-NEUTRAL (no change needed for parity, data already generic in shape):**

- Repo tree browser (`RepoTreeBrowser.vue`, `github.repoTree.*`), the repo search combobox
  (`GitHubRepoSearchSelect.vue`) + empty state (`RepoSearchEmpty.vue`), branch listing, and
  the `owner/name` label rendering — all operate on already-generic projection data
  (`RepoTreeEntry`, `GitHubAvailableRepo`), so they only inherit the label/icon switch above.
- The single store keyed on `repoGithubId` is reused as-is (projection tables stay
  GitHub-named on purpose — see gotchas).

**Already provider-aware (the reference pattern to copy):** `LoginScreen.vue` + `stores/auth.ts`
already switch on `('github'|'gitlab')` — provider labels, `i-lucide-{github,gitlab}` icons,
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

## Conventions & gotchas

- **Never re-hardcode GitHub** (or GitLab): hosts come from `ResolveRepoOrigin`, identity
  fields are `repoId`/`connectionId`/`provider`. A new persisted or wire type with a
  `github*` name is a review-blocker.
- **The GitHub-issue-specific consumers must NOT gain the GitLab fallback** — keep
  `engineVcsClient` vs App-only `githubClient` distinct (a GitLab deployment must not
  offer a dead "GitHub Issues" source).
- **Terminology is a locale problem**: "Pull request"/"Merge request" and similar strings
  are provider-keyed i18n lookups (tier-2 exhaustive `Record` on `VcsProvider`), not
  ternaries with raw strings.
- The projection tables are still GitHub-named (`github_repos`/`github_installations`) and
  intentionally reused as-is — do not block UI parity on renaming them (that fold is the
  separate, acknowledged Phase-1 entity-naming work).
