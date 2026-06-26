---
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Surface account & team management in the UI

The existing per-account management features (members + roles, email invitations, and the
transactional email sender) are now reachable from a dedicated **Account settings** entry
in the SideBar Configuration section (and the account switcher), instead of being buried in
an org-only "Manage team…" dropdown item. On a personal account the panel prompts the user
to create an organization, since members/roles/invitations are org-scoped.

Email provider configuration no longer requires the `EMAIL_ENABLED` env var: the email
module is available whenever an encryption key is set (`ENCRYPTION_KEY`, used to seal the
per-account provider API key). **Breaking:** the `EMAIL_ENABLED` flag is removed — deployments
that set it can drop it; email becomes available based on `ENCRYPTION_KEY` presence alone.
