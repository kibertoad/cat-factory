---
---

Docs only: two initiative trackers, each recording a design that was investigated against the
code rather than sketched.

`enterprise-sso-oidc.md` covers generic OIDC sign-in (one adapter configured per deployment, not
per-vendor integrations, reusing the already provider-keyed `user_identities` table as-is). It
carries a finding that changes how its paired slice should be sized: the paired revocation
tracker assumed the generation check could fold into "the user resolution the request already
performs", and there is no such resolution — `requireAuth` verifies the HMAC and never touches
the user row. So revocation is a deliberate trade between a cached read on the auth hot path and
a bounded revocation window, with a user-row column behind it either way. Both trackers now say
so, and `backend/docs/auth.md` points at them.

`role-scoped-submission-allowlists.md` covers the per-class sandbox: ADR 0037's `classRulesByRole`
with `never` still lets the initiator merge their own run's review card (the merge route carries
no permission gate beyond the RBAC write floor), and `dryRunRoles` closes that only for every
class at once. The allowlist is the middle, refused at both exits like `dry_run`.
