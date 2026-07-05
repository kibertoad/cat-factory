---
'@cat-factory/integrations': patch
'@cat-factory/app': patch
---

Surface a real, actionable error when "auto-detect" (test-infra provisioning / frontend config)
can't read the repository. Before, a genuine read fault (revoked App access, missing
`Contents: read`, a rate limit, or a token-mint/transport error) was either masked as a
misleading "nothing found" or escaped as an opaque 500, and the SPA discarded whatever the
backend said and showed a fixed "Could not read the repository to detect provisioning." line.

Now the checkout-free detectors record a genuine (non-404) reader throw and raise a
`RepoReadError` when they detected nothing because of it; the environments service maps that to a
`ValidationError` naming the repo and the underlying reason, with provider-aware guidance to check
repository read access and rate limits (a GitHub-specific "Contents: read" hint only when the
detect input pinned GitHub, a GitLab `read_repository` hint for GitLab, neutral otherwise — so a
GitLab deployment isn't told to fix a GitHub-only permission). The inspector's Detect affordance
surfaces the server's real message, and distinguishes the client-only "this frame's repo isn't in
the connected repos" case with its own `inspector.detectRepoUnresolved` copy instead of the generic
read-failure line.
