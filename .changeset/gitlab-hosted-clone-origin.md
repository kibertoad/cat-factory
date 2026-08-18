---
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
---

Clone from the GitLab instance a hosted deployment is configured for.

`ResolveRepoOrigin` was supplied by local mode alone, so the Node and Cloudflare facades fell
through to the `github.com` default and a GitLab-only deployment handed every agent container a
`https://github.com/<group>/<project>.git` clone URL while gating and merging on GitLab. Both
facades now derive the clone host and the harness's clone-credential allow-list from
`GITLAB_API_BASE`, and local mode reads the same derivation instead of its own. The Worker's PR
verification-report publisher and its deploy clone target join the same origin, and the local
native transport (`LOCAL_NATIVE_AGENTS`) joins the same allow-list derivation the container
transport already used.

Behaviour changes to know about. A `GITLAB_API_BASE` that names no web host now fails the dispatch
with a message naming the variable, where it previously produced a github.com clone URL; it
likewise allow-lists no host, where local mode previously fell back to `gitlab.com`. On a mixed
deployment (a GitHub App beside per-workspace GitLab connections) a repository the projection marks
as living on the other provider is now refused rather than cloned from the wrong host: the dispatch
throws naming the repository, and the environments module's block-less repo resolver reports "no VCS
connection". A run that previously checked out a same-named GitHub project therefore stops instead.

On a self-hosted runner pool the harness needs `GITHUB_ALLOWED_HOSTS` set to the GitLab host, since
the pool's containers are the operator's rather than the platform's. It is now in
`docs/environment-variables.md` and on the website's runner-pool and configuration pages.

The environments module's block-less repo resolver also stops refusing every caller that names
`gitlab`. It now refuses only a repository the bound client cannot read, or one whose named provider
the repo projection disagrees with.
