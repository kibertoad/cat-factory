---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

GitLab connect UI (GitLab UI-parity slice 2b). A workspace can now connect GitLab from the
product: the source-control panel and the connect onboarding gate render a personal-access-token
field (`components/vcs/GitLabConnect.vue`) alongside — or instead of — the GitHub App
installation picker, showing the upstream validation error inline when a token is rejected.

Which surfaces appear comes from a new provider-neutral capability route,
`GET /workspaces/:ws/vcs/connect-options`, which reports what the deployment actually wired
(`github/app`, `gitlab/pat`, both, or neither) — previously the SPA could not tell, so a
GitLab-only deployment still offered an App picker it could not serve. The `github` store probes
it with the connection and exposes `canConnectGitHubApp` / `canConnectGitLabPat` /
`soleConnectProvider` / `provider`, and `disconnect()` now routes to the connected provider.

Panel/onboarding chrome (title, icon, connection line, disconnect copy) is provider-aware:
brand labels/icons/token URLs are shared `Record<VcsProvider, …>` constants in
`app/utils/vcs.ts` (lifted out of `LoginScreen.vue`), and prose moved to a provider-parameterised
`vcs.*` i18n namespace in all 10 locales. **Breaking (SPA catalog):** the GitHub-App-specific
`github.onboarding.title` / `github.onboarding.intro` and `github.panel.confirmDisconnect` /
`github.panel.toast.disconnected` keys are replaced by `vcs.onboarding.*` / `vcs.panel.*`, so a
deployment overriding those keys must rename them.
