---
'@cat-factory/gitlab': patch
'@cat-factory/worker': patch
'@cat-factory/server': patch
---

Make GitLab a first-class auth identity on the hosted (Cloudflare Worker + Node) path.

**Wire hosted PAT sign-in into the Cloudflare Worker.** The Worker now registers the PAT-login
identity registry (`vcsIdentity`) like the Node facade — GitHub always, GitLab when a GitLab
connection is configured (`GITLAB_TOKEN` / `config.gitlab.enabled`) — so a user can sign in by
pasting their own GitHub **or** GitLab PAT at `/auth/pat`. Previously the Worker wired none,
leaving it OAuth-only; since GitLab has no OAuth browser flow, a GitLab user had no way to sign
in to a Worker deployment at all, even though its engine already gated CI and merged on GitLab.
`/auth/config` now advertises `patLogin.providers` accordingly, so the SPA renders the PAT form.

**Implement `GitLabIdentityResolver.resolveOrgs`.** A hosted deployment admits a pasted PAT only
when the account's login, an org/group it belongs to, or its email domain is allowlisted. Only
`GitHubIdentityResolver` implemented `resolveOrgs`, so `isPatIdentityAllowed`'s org branch was
skipped for GitLab — a GitLab account could be a primary identity via `AUTH_ALLOWED_LOGINS` or
`AUTH_ALLOWED_EMAIL_DOMAINS`, but never `AUTH_ALLOWED_ORGS`. The resolver now enumerates the
user's GitLab **group** memberships (`GET /groups?min_access_level=10`, lowercased full paths, so
only groups the user actually belongs to admit), bringing group-based admission to parity with
GitHub org admission.

Comment-only touch to `@cat-factory/server`'s `AuthController` to correct the now-stale "hosted
facades authenticate via OAuth" note.
