---
"@cat-factory/gitlab": minor
"@cat-factory/kernel": patch
---

Add `@cat-factory/gitlab`: the opt-in GitLab VCS provider, the proof-of-concept
second backend for the provider-neutral VCS abstraction. It implements the
neutral `VcsClient` (repo/branch/MR/issue/CI reads + writes over the GitLab REST
v4 API), a `VcsWebhookVerifier` + `VcsWebhookMapper` (constant-time
`X-Gitlab-Token` check; `Merge Request`/`Issue`/`Push`/`Pipeline` hooks →
neutral events), and a `VcsProvisioningClient`, and registers itself via
`registerGitLab()` → `registerVcsProvider('gitlab')`. Depends only on
`@cat-factory/kernel` + `@cat-factory/contracts`; not yet wired into the live
execution flow (that follows once consumers migrate off the GitHub-specific
ports). Also refines the kernel `VcsWebhookMapper` port to take the resolved
connection as a parameter.
