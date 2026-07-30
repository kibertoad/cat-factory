---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Report infrastructure that is configured but DEAD, live — the reachability watcher deferred out of
the `cat-factory supervise` PR (#1527), plus the wire contract and the banner it produces for.

The infra-setup banner could only say "you never set this up". A provider that WAS set up and has
since died looked identical to a healthy one, because the projection asks whether a connection ROW
exists, not whether anything answers. That gap is how an outage sits unnoticed for a day: every
testing agent fails while the board reports a perfectly healthy setup.

## The watcher

`sweepInfraReachability` is a runtime-neutral sweep (Worker cron ⇄ Node interval, exactly like
`sweepPlatformHealth`). For each board it probes the SAVED environment-provider and runner-pool
connections through new `probeSavedConnection` methods — distinct from `testConnection`, which
answers "would this config work" for an operator at a form and asserts config safety. Re-running
that safety assertion against an already-persisted connection would report it as an outage the
moment a deployment tightened its URL policy, so the probe makes none.

Opt-in (`INFRA_REACHABILITY_WATCH`): it is the one sweep that makes an outbound call per workspace
per pass, to infrastructure the deployment does not own. That cost profile is the operator's call.

Three probe results, deliberately not two. A probe that ANSWERED `ok: false`, or did not answer
inside the per-probe budget, is an outage. A probe that THREW, or reported nothing to test, is
INDETERMINATE and leaves the recorded state exactly as it was — a throw is a LOCAL fault (an
unresolvable connection, a secret bundle that would not decrypt), and blaming the operator's cluster
for our own missing key is the "never infer a cause from the presence of an error" trap.

## Where the last-observed state lives

The contract requires publishing on TRANSITION only, which needs durable prior state — a Worker cron
tick runs in a fresh isolate, so in-memory would re-announce every ongoing outage every pass. Rather
than a table, the state is the workspace's open `infra_unreachable` notification and its
`payload.unreachableAreas`, the same way the platform-health sweep uses its card's `platformAlerts`
set. That card is already durable, already runtime-symmetric, already routed for mothership mode and
already read by the board snapshot — so the sweep needs one batched `listOpenByType` and the
projection folds the same record with no extra query and no probe on the board-load path. An
operator also gets an inbox card and a Slack route for the outage, which is the right surface for it
anyway.

The per-area probe REASON is not persisted there: it varies between passes, and any content change
re-delivers the card, so it would re-toast the inbox for the whole outage. It rides the live
transition instead — which is when someone is actually looking.

## The wire contract and the banner

- `infraSetupStatusSchema` gains **`unreachable`**, riding the existing setup projection rather than
  a second "your infra is broken" surface: the consequence is identical to `not_defined` (a class of
  agents cannot run) and the same operator surface fixes it, so the banner, deep-link and i18n are
  reused.
- `isInfraSetupHealthStatus` + `INFRA_SETUP_HEALTH_STATUSES` mark it a HEALTH state, and the banner
  honours the difference: the other three statuses are stable operator decisions, so they offer a
  permanent per-user "don't notify me again"; applying that to an outage would let one click silence
  every future occurrence. An outage is session-dismissible only, it re-nags on recurrence, and it
  ignores a permanent dismissal recorded against the SETUP gap — a different claim about a different
  state.
- `WorkspaceEvent` gains **`infraSetup`**, carrying the area, the new status and the probe's reason,
  which the SPA applies as a targeted one-field patch. A coarse refresh would pay the whole snapshot
  aggregate for a one-field delta.

## Also fixed

`FanOutEventPublisher` delegates method-by-method, so any event it does not name is silently dropped
for every deployment wiring the in-org fan-out — nothing throws, the browser just never updates.
`kaizenGradingChanged` was already being dropped that way. Both it and the new `infraSetupChanged`
now forward, and a structural test reflects the port's own surface so the next added event fails
there instead of in production.
