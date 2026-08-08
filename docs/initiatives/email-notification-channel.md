# Initiative: email as a NotificationChannel

**Status:** in progress (slices 1-3 landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Everything this feature needs already existed except the feature itself:

- The **`EmailSender` kernel port** (`kernel/src/ports/email-sender.ts`) with **SendGrid +
  Resend adapters** (`integrations/src/modules/email/adapters.ts`) is live, per-account
  onboarded with encrypted keys, but was used only for **invitations**.
- The **`CompositeNotificationChannel`** seam (`kernel/src/ports/notification-channel.ts`)
  was built exactly for additional channels (per-channel error isolation, fan-out), and
  already fanned out in-app + Slack.

The gap: every human-actionable notification (`merge_review`, `ci_failed`,
`pipeline_complete`, `release_regression`, `fork_decision_pending`) reached only the
in-app inbox and Slack. A user who isn't in the app and doesn't run the Slack integration
learns their pipeline parked on a decision... never. Email is the lowest-common-denominator
channel and the smallest effort-to-value item on the improvement list.

End state: an `EmailNotificationChannel` behind the composite, with per-type notification
preferences (off by default for the noisy types, so nobody gets a firehose unrequested),
digest-safe batching, and deep links into the app.

## Target pattern

1. **`EmailNotificationChannel`** in `@cat-factory/integrations` (beside
   `SlackNotificationChannel`, the shape it copies): implements `NotificationChannel`,
   resolves the account's configured `EmailSender`, renders the notification into a
   plain-text-first subject/body pair, and sends to the _resolved recipients_ (see #3).
   Composed into each facade's EXTERNAL channel set (it sends through the account's sealed
   provider key, so under mothership mode only the mothership can deliver it), and only when
   an email sender is configured (the opt-in wiring convention).
2. **The notification MANAGER** rather than the per-user preference store originally
   sketched: `notification_settings`, one row per workspace, storing per-type, per-channel
   OVERRIDES over the shipped defaults. `NotificationSettingsService` answers BOTH the
   settings API and the `NotificationRouter` the delivery gate asks, so what a human toggles
   and what the engine does cannot come from two readings of one row. The resolution
   (`isNotificationRouted`) lives in `@cat-factory/contracts`, because the SPA renders the
   same answer.
3. **Batch, don't loop**: resolving recipients is batched reads (the account roster, the
   board roster, then the users by id), never per-user point-reads (the N+1 rule). Sends
   iterate the resolved list: an external send per recipient is inherent, but with bounded
   concurrency and per-recipient error isolation (one bad address must not drop the rest;
   the composite's isolation philosophy, one level down).
4. **Rendering**: plain-text-first bodies assembled from the same machine-readable
   notification payload the inbox renders, plus a deep link built from `appBaseUrl` (absent
   ⇒ no link, and every body stands on its own). No HTML templating engine; the HTML part
   escapes the model- and user-authored holes, being a rendered surface like a PR body.

## Which channels the manager routes, and why not all of them

`in_app` and `email` are workspace-wide yes/no per type, so a matrix is the whole story.
Slack and the outbound webhooks are DESTINATION-configured — a Slack route carries the
channel it posts to, a webhook endpoint carries its own `types` filter — so "which types" is
answered where the destination is declared. Adding them to the matrix would be a second
switch for a decided question, and the failure mode is a user muting a type in one place and
watching it keep arriving from the other.

## Interface tier

The manager is **basic**-tier: it is listed in the Integrations hub and the command bar in both
interface modes. "Which events reach my email" is an everyday-loop question, not an expert knob,
and email ships high-impact-only, so the first thing a user wants after connecting a sender is to
add or drop a type. Nothing in the panel is an override of a value shown elsewhere, so the
hide-an-override rule does not apply.

## Prioritized checklist

| #   | Slice                                                                                                                              | Status  | PR                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------- |
| 1   | `EmailNotificationChannel` + facade wiring behind "sender configured" + audience resolution derived from `resolveWorkspaceAccess`  | ✅ done | email-notifications-manager |
| 2   | `notification_settings` store (D1 ⇄ Drizzle + conformance) + `NotificationSettingsService` + contracts + the admin-gated HTTP pair | ✅ done | email-notifications-manager |
| 3   | The manager UI (per-type × per-channel switches in the notifications panel; i18n across all locales)                               | ✅ done | email-notifications-manager |
| 4   | Per-USER opt-outs layered under the workspace matrix (a personal "not this one for me")                                            | ⬜ todo |                             |
| 5   | Deep links in bodies beyond `?ws=&block=&run=` (after `global-search-and-deep-links` slice 6)                                      | ⬜ todo |                             |
| 6   | Rate/dedup guard: coalesce repeat notifications for the same entity within a window, and a digest mode                             | ⬜ todo |                             |
| 7   | Per-user locale for rendered bodies (today the backend does not localize prose)                                                    | ⬜ todo |                             |

## Conventions & gotchas

- **Channel failures never block the row**: the canonical notification is persisted first;
  a channel throw is isolated (the composite guarantees this; the email channel's own
  per-recipient sends are equally isolated).
- **Off means silent**: an account with no email sender configured, or a type routed off,
  produces zero attempts and zero warnings — the standard opt-in pass-through shape.
- **A routing read that FAILS falls back to the shipped default and logs.** It must not
  default to deliver-everything (a mailshot on a settings-store outage) nor to
  deliver-nothing (the parked run nobody hears about). `RoutedNotificationChannel` owns that.
- **A cell is an OVERRIDE, not the value.** Absent means "this board never chose", which
  resolves to the default. The panel therefore SAVES ONLY the differences: a full grid would
  freeze today's defaults onto every board that ever pressed save, so a later change to what
  counts as high impact would reach nobody.
- **Gating `in_app` is a mute on the live PUSH, never on the card.** The row is persisted
  either way and still lists in the inbox on the next snapshot. Anything that made the toggle
  hide a parked run would make the whole matrix unsafe.
- **Don't email secrets or prompt content**: bodies carry the same redacted projection the
  inbox shows, nothing from agent contexts or credentials. The HTML part escapes its holes.
- **Backend does not localize prose**: bodies are assembled from the notification's
  machine-readable fields; localized email is slice 7 (per-user locale), not string
  concatenation in the channel.
- The e2e backend keeps email OFF (unconfigured), preserving the "only external deps
  faked/absent" invariant.
