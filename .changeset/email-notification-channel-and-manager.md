---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Deliver notifications by email, and add the notification manager that decides which events go to
which channel.

The `EmailSender` port, its SendGrid/Resend adapters and the per-account connection have been live
for a while and were used only for invitations. A new `EmailNotificationChannel` puts them behind
the same `NotificationChannel` port the in-app and Slack transports implement, so the engine call
sites that raise notifications are untouched. It resolves recipients from the SAME rules
`resolveWorkspaceAccess` applies (account membership is the prerequisite, an account admin always
qualifies, a `workspace_members` row counts only for a still-current account member), reads them in
three batched queries rather than a point-read per person, and isolates each send so one bad address
cannot cost every other recipient their notification. An account with no sender connected produces
zero attempts and zero warnings.

The manager (`notification_settings`, one row per workspace, D1 ⇄ Drizzle with a conformance suite)
stores per-type, per-channel OVERRIDES over the shipped defaults, and one service answers both the
settings API and the delivery gate so the toggle a human sees cannot say something the engine does
not do. **By default email carries only the high-impact events**: the ones where something is
stopped until a human acts (`merge_review`, `decision_required`, `ci_failed`, `test_failed`,
`release_regression`) or the deployment itself is degraded (`platform_health`, `infra_unreachable`,
`budget_paused`, `key_drift`). The per-step review parks are deliberately off by default — several
arrive on nearly every task, and mailing them is the firehose that gets a sender's domain filtered.

Only the channels whose delivery is a plain yes/no are routed here: the in-app push and email.
Slack and the outbound webhooks answer "which types" where their DESTINATION is declared (a Slack
route's channel, a webhook endpoint's own `types` filter), so a second switch would be a place to
look that does not decide. The settings panel says so and links to the Slack routing.

Two behaviours to watch for when reviewing. The in-app push is now gated too: muting a type stops
the live toast but the card is still persisted and still in the inbox on the next snapshot, which is
what makes the toggle safe rather than a way to hide a parked run. And a settings read that FAILS
falls back to the shipped default and logs, rather than defaulting to deliver-everything (a
mailshot) or deliver-nothing (the parked run nobody hears about).
