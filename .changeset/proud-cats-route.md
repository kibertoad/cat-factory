---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Make the provider-routing VCS client reflective, so it can no longer under-report the port.

`ProviderRoutingGitHubClient` was a hand-written delegate over a 53-method port, 20 of whose
methods are optional. It implemented the 33 required ones and 18 of the optional ones were
simply absent, which typechecks precisely because they are optional. `providerRoutingGitHubClient`
replaces it with a `Proxy` (the shape `runtimes/local/src/vcsClientRouter.ts` already documents),
so the surface it presents is the union of what its backing clients implement.

Behaviour change, in a deployment running BOTH a GitHub App and GitLab connect: the branch
protection preflight now answers for real on GitHub installations, where it previously reported
`capability: 'unavailable'` for the whole workspace. A call landing on a provider whose client
does not implement the method refuses with the new `VcsCapabilityUnsupportedError` rather than
`undefined is not a function`; `GitHubService.checkDefaultBranchProtection` absorbs it and keeps
reporting `unavailable`, which is exactly the fact it already models.
