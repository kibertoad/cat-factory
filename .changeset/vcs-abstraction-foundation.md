---
'@cat-factory/kernel': minor
---

Add a provider-neutral VCS abstraction foundation: neutral identity types
(`VcsProvider` / `VcsConnectionRef` / `VcsRepoRef`), a per-provider adapter
registry (`registerVcsProvider` / `resolveVcsProvider`, modelled on the gate
registry), and the neutral port surface (`VcsClient`, `VcsProvisioningClient`,
`VcsWebhookEvent` / `VcsWebhookMapper`). These are the seams other VCS systems
(GitLab first) plug into; the GitHub adapter and consumers migrate onto them in
follow-up changes. Additive — no existing behaviour changes yet.
