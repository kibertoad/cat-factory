# Initiative: email as a NotificationChannel

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Everything this feature needs already exists except the feature itself:

- The **`EmailSender` kernel port** (`kernel/src/ports/email-sender.ts`) with **SendGrid +
  Resend adapters** (`integrations/src/modules/email/adapters.ts`) is live, per-account
  onboarded with encrypted keys — but used only for **invitations**. Its own port comment
  says it "could back an email NotificationChannel later."
- The **`CompositeNotificationChannel`** seam (`kernel/src/ports/notification-channel.ts`)
  was built exactly for additional channels (per-channel error isolation, fan-out), and
  already fans out in-app + Slack.

The gap: every human-actionable notification — `merge_review`, `ci_failed`,
`pipeline_complete`, `release_regression`, `fork_decision_pending` — reaches only the
in-app inbox and Slack. A user who isn't in the app and doesn't run the Slack integration
learns their pipeline parked on a decision... never. Email is the lowest-common-denominator
channel and the smallest effort-to-value item on the improvement list.

End state: an `EmailNotificationChannel` behind the composite, with per-user notification
preferences (off by default per type, so nobody gets a firehose unrequested), digest-safe
batching, and deep links into the app (see the `global-search-and-deep-links` initiative).

## Target pattern

1. **`EmailNotificationChannel`** in `@cat-factory/integrations` (beside
   `SlackNotificationChannel`, which is the shape to copy): implements
   `NotificationChannel`, resolves the account's configured `EmailSender`, renders the
   notification into a plain, translated-later subject/body pair, and sends to the
   *resolved recipients* (see #3). Registered into `CompositeNotificationChannel` in every
   facade **only when an email sender is configured** (the opt-in wiring convention).
2. **Recipient + preference model**: a small `notification_preferences` per-user store
   (D1 ⇄ Drizzle + conformance): per notification type, `email: on|off`. Default OFF for
   noisy types, ON only for the genuinely rare human-gates (`merge_review`,
   `release_regression`) — tune the defaults in review. Recipients for a workspace
   notification = the account members with access to that workspace (respect the
   `workspace-rbac` initiative once it lands) filtered by preference.
3. **Batch, don't loop**: resolving recipients and preferences is batch reads (one
   membership list + one preferences `IN` query), never per-user point-reads (the N+1
   rule). Sends iterate the resolved list — an external send per recipient is inherent, but
   apply bounded concurrency and per-recipient error isolation (one bad address must not
   drop the rest — the composite's isolation philosophy, one level down).
4. **Rendering**: plain-text-first bodies assembled from the same machine-readable
   notification payload the inbox renders; a deep link when the deep-links initiative
   lands (until then, the workspace URL). No HTML templating engine — keep the payload the
   source of truth.

## Prioritized checklist

| # | Slice | Status | PR |
| - | ----- | ------ | -- |
| 1 | `EmailNotificationChannel` (fixed sensible type filter, no preferences yet) + facade wiring behind "sender configured" + conformance/pass-through assertion | ⬜ todo | |
| 2 | `notification_preferences` store (D1 ⇄ Drizzle) + service + contracts | ⬜ todo | |
| 3 | Preferences UI (per-type toggles in personal settings; i18n all locales) | ⬜ todo | |
| 4 | Recipient resolution via workspace access (coordinate with `workspace-rbac`) | ⬜ todo | |
| 5 | Deep links in bodies (after `global-search-and-deep-links` slice 6) | ⬜ todo | |
| 6 | Rate/dedup guard: coalesce repeat notifications for the same entity within a window | ⬜ todo | |

## Conventions & gotchas

- **Channel failures never block the row**: the canonical notification is persisted first;
  a channel throw is isolated (the composite already guarantees this — keep the email
  channel's own per-recipient sends equally isolated).
- **Off means silent**: an account with no email sender configured, or a user with the
  preference off, produces zero attempts and zero warnings — the standard opt-in
  pass-through shape.
- **Don't email secrets or prompt content** — bodies carry the same redacted projection the
  inbox shows, nothing from agent contexts or credentials.
- **Backend does not localize prose**: bodies are assembled from the notification's
  machine-readable fields; if/when localized email is wanted, that's a deliberate later
  slice (per-user locale), not string concatenation in the channel.
- The e2e backend keeps email OFF (unconfigured), preserving the "only external deps
  faked/absent" invariant.
