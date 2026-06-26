---
---

docs: document the full sign-in access-control model in `backend/docs/auth.md`.
The doc covered only GitHub login/org allowlists; it now also describes the Google
OAuth and email/password providers, the `AUTH_ALLOWED_EMAIL_DOMAINS` self-signup
allowlist, the invitation bypass, and that gating is per-login-method (GitHub
login/org vs email-domain) rather than a single combined rule.
