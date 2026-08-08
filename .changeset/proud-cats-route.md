---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': patch
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

Reflecting means deciding what counts as a member, and the first answer was too generous:
membership was tested with `Reflect.has`, which walks into `Object.prototype`, so `toString`,
`valueOf`, `constructor` and the rest were answered with installation-routing functions. Coercing
the client to a string called `toString()` with no arguments, which routed on `undefined` as the
installation id and returned a promise where a primitive was required, so a template literal or a
logger touching the client threw `TypeError: Cannot convert object to primitive value` with an
unawaited repository read rejecting behind it. Membership now stops at `Object.prototype` and
anything that is not a port member is answered by the proxy target, so those names behave as they
do on any object while an unimplemented optional method still reads as absent.

`VcsCapabilityUnsupportedError`'s reason joins the shared `UNAVAILABLE_REASONS` vocabulary and
gains translated SPA copy. Without it the refusal rendered as the generic 503 wording, "this
deployment has not configured the capability", which is the misattribution the class exists to
prevent: no operator wiring changes what a provider does not offer. Its sibling
`vcs_client_unconfigured` deliberately stays on the generic copy, because that one IS a wiring gap.
