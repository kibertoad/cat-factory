# Initiative: GitLab product-surface parity (SPA)

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

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
  the projection needs, (b) making the shared components provider-aware in *presentation*
  (labels, icons, URL shapes) while staying provider-neutral in *data*.
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

| # | Slice | Status | PR |
| - | ----- | ------ | -- |
| 1 | Audit pass: enumerate every GitHub-only affordance/copy in `components/github/*` + stores; classify neutral vs provider-keyed (write findings into this tracker) | ⬜ todo | |
| 2 | Per-workspace GitLab PAT connect flow (backend rows + connect UI mirroring `GitHubConnect.vue`) | ⬜ todo | |
| 3 | Project browse / add-service-from-project through the shared store (provider-aware labels) | ⬜ todo | |
| 4 | Webhook setup surface (register the GitLab webhook + secret for a connected project) | ⬜ todo | |
| 5 | Provider-keyed copy pass: PR/MR terminology, host/URL rendering, icons — i18n'd, all locales | ⬜ todo | |
| 6 | Onboarding: provider choice step (GitHub App / GitHub PAT / GitLab PAT) in the connect onboarding | ⬜ todo | |
| 7 | OAuth-based GitLab connect (the `gitlab-parity.md` future-work item) | ⬜ todo | |
| 8 | e2e: GitLab-flavoured connect→add-service against a faked VCS boundary (MSW at the backend outbound boundary) | ⬜ todo | |

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
