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
`GITLAB_API_BASE`, and local mode reads the same derivation instead of its own.

Two behaviour changes to know about. A `GITLAB_API_BASE` that names no web host now fails the
dispatch with a message naming the variable, where it previously produced a github.com clone URL;
and it likewise allow-lists no host, where local mode previously fell back to `gitlab.com`. On a
self-hosted runner pool the harness needs `GITHUB_ALLOWED_HOSTS` set to the GitLab host, which is
now documented.

The environments module's block-less repo resolver (compose `repo` layers, on-demand config
validation) also stops refusing every caller that names `gitlab` and refuses only a caller whose
named provider the repo projection disagrees with.
