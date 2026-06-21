---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
'@cat-factory/app': minor
---

Add configurable Slack notifications as an additional delivery transport for the
existing notification mechanism (merge_review / pipeline_complete / ci_failed) —
not a parallel system. A new `SlackNotificationChannel` implements the same
`NotificationChannel` port the in-app channel does and is composed alongside it via
`CompositeNotificationChannel`, so the engine call sites that raise notifications
are untouched.

Two scopes, mirroring the GitHub-App precedent:

- The Slack **connection** (the installed team + its bot token) is bound
  **per-account**. The bot token is multi-tenant data, so it is encrypted at rest
  with `WebCryptoSecretCipher` (HKDF tag `cat-factory:slack`) and never returned on
  the wire — only safe metadata (team name/icon, bot user, scopes) is exposed.
  Onboarding is UI-based: a full OAuth "Add to Slack" flow when the app credentials
  are configured (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_REDIRECT_URL`),
  with manual bot-token paste always available as a fallback.
- Notification **routing** (which types post, to which channel) is configured
  **per-workspace**.
- Optional **@-mentions** are **role- and audience-aware**, not a workspace
  broadcast. The per-account member map tags each member `product` or `engineering`,
  and each notification type mentions a specific audience: requirement-review
  findings ping **product** people **plus the task's creator**, while the engineering
  notifications (merge_review / pipeline_complete / ci_failed) ping **only the task's
  creator**. This adds a `requirement_review` notification type (raised by the
  requirements reviewer when it produces findings) and records a `createdBy` on
  blocks (a new nullable column on both runtimes), captured from the authenticated
  user at task creation.

New surface: the `slack` contracts, the kernel Slack repository ports, the
`@cat-factory/integrations` Slack module (`SlackNotificationChannel`,
`SlackConnectionService`, `SlackSettingsService`, `SlackMemberMappingService`,
`SlackApiClient`), the shared `SlackController` (+ public OAuth callback) and
`SlackConfig`, and the orchestration `SlackModule`. Persisted on **both** runtimes:
the Cloudflare D1 tables (migration `0037_slack.sql`) and the Node Postgres tables
(Drizzle schema + generated migration), with both facades wiring the channel +
management module. The cross-runtime conformance suite asserts the routing and
member-map persistence parity on both stores.

This change also closes a pre-existing parity gap: the Node/Drizzle facade now has
a `notifications` table + `DrizzleNotificationRepository` and wires
`notificationRepository`, so the notification subsystem — and any channel composed
onto it — fires on the Node runtime exactly as on the Worker.

Opt-in via `SLACK_ENABLED=true` (requires `ENCRYPTION_KEY`); off by default, so
unconfigured deployments are unaffected.
