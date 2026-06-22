---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Workspace creation/onboarding overhaul: real users, non-GitHub auth, invites,
named+described boards.

- **Persistent identity**: a new `users` + `user_identities` model replaces the
  GitHub-numeric-id identity. Memberships, `blocks.created_by`, personal
  subscriptions, and the session payload are all re-keyed to a generated `usr_*`
  id. (BREAKING: pre-existing personal accounts — keyed by GitHub login with a null
  `owner_user_id` — stop matching and a fresh personal account is created on next
  sign-in; old member-mapping rows keyed by GitHub id are orphaned. No migration,
  per the pre-1.0 policy.)
- **Non-GitHub auth**: email/password (WebCrypto PBKDF2 hashing) and Google OAuth
  login alongside GitHub. New-user creation is invite-only plus an optional
  `AUTH_ALLOWED_EMAIL_DOMAINS` self-signup allowlist (fail-closed). A user without
  a GitHub account works fully — repo access is via the GitHub App, not a user token.
- **Email invitations**: invite teammates by email into an org account; the invitee
  redeems a tokened link to gain membership. Email is sent via a pluggable
  `EmailSender` (SendGrid / Resend adapters) whose provider + API key are
  **onboarded per-account in the UI and stored sealed in the DB** (not env), like
  the Slack bot token. New tables: `users`, `user_identities`, `account_invitations`,
  `email_connections` (D1 + Drizzle).
- **Board name + description**: `Workspace.description` end to end (create + edit).
- **Onboarding discovery**: org members see and open existing org boards from the
  switcher instead of being forced to create one.
- Slack member-mapping is re-keyed from `githubUserId` to the internal `userId`.
