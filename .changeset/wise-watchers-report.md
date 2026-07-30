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

FOUR probe results, deliberately not two, because they need four dispositions. A probe that ANSWERED
`ok: false`, or did not answer inside the per-probe budget, is an outage. A probe that THREW, or that
could not be asked at all (a de-registered backend kind, an unparseable config), is INDETERMINATE and
leaves the recorded state exactly as it was — a throw is a LOCAL fault (an unresolvable connection, a
secret bundle that would not decrypt), and blaming the operator's cluster for our own missing key is
the "never infer a cause from the presence of an error" trap. An area with NOTHING REGISTERED is
neither: it is knowably not an outage, so the recorded failure is forgotten while announcing nothing
(the honest next state is the `not_defined` setup gap the snapshot recomputes, not a "recovered"
push). Collapsing those last two — as a `ConnectionTestResult | null` return forced — meant an
operator who fixed a dead runner pool by UN-REGISTERING it kept the open card forever, escalating
red, since nothing but a probe clears a record only a probe writes.

The watcher probes exactly the areas the snapshot projection would NAG about, through the one shared
`infraSetupAreaApplies` predicate. Gating on "is the module wired" (which the projection does not)
was strictly looser: `agentExecutorRequiresRunnerPool` is unset on Cloudflare and false on local
mode, so a dead-but-optional runner pool raised a card, paged Slack and pushed `unreachable` for an
area whose banner the projection then refused to render — an outbound probe cost paid to report
something nobody could see on reload.

`INFRA_REACHABILITY_INTERVAL_MS` now means the same thing on both facades. The Worker's `scheduled`
tick fires every 2 minutes for every backstop it drives, so the operator's only lever on the one
sweep that calls out per workspace did nothing there; the sweep now runs only on the tick that opens
a new interval window — pure arithmetic on the cron's aligned timestamp, so it stays stateless in a
fresh isolate.

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
transition instead — which is when someone is actually looking — and the banner RENDERS it, since a
refused connection, a rejected token and a timeout need different fixes and the generic body cannot
tell them apart. Absent after a reload, so it is an addition to the copy rather than the only thing
that explains the card.

## The wire contract and the banner

- `infraSetupStatusSchema` gains **`unreachable`**, riding the existing setup projection rather than
  a second "your infra is broken" surface: the consequence is identical to `not_defined` (a class of
  agents cannot run) and the same operator surface fixes it, so the banner, deep-link and i18n are
  reused.
- `isInfraSetupHealthStatus` + `INFRA_SETUP_HEALTH_STATUSES` mark it a HEALTH state, and the banner
  honours the difference: the other three statuses are stable operator decisions, so they offer a
  permanent per-user "don't notify me again"; applying that to an outage would let one click silence
  every future occurrence. An outage is session-dismissible only and it re-nags on recurrence. BOTH
  dismissals are keyed by the CLAIM (area + kind), never by the area alone, because the two cards an
  area can raise say different things about it: silencing "you haven't configured this" must not also
  silence the outage card raised after the operator configures it and the provider then dies.
- `applyInfraSetupTransition` (contracts) is the ONE rule about which prior state a probe verdict may
  overwrite — only a `configured` area may become `unreachable` — and both delivery paths fold
  through it: the backend's snapshot projection and the SPA store's live patch. The live patch used
  to assign unconditionally, so a pushed `unreachable` rendered a red "check that the service is
  running" banner over a `not_applicable`/`not_defined` area, which then vanished on the next reload.
  A banner that contradicts the projection is worse than a late one.
- `WorkspaceEvent` gains **`infraSetup`**, carrying the area, the new status and the probe's reason,
  which the SPA applies as a targeted one-field patch. A coarse refresh would pay the whole snapshot
  aggregate for a one-field delta.

## Also fixed

`FanOutEventPublisher` delegates method-by-method, so any event it does not name is silently dropped
for every deployment wiring the in-org fan-out — nothing throws, the browser just never updates.
`kaizenGradingChanged` was already being dropped that way. Both it and the new `infraSetupChanged`
now forward, and a structural test reflects `NoopEventPublisher`'s surface so the next added event
fails there instead of in production. `NoopEventPublisher` is in turn pinned to
`Required<ExecutionEventPublisher>`, which closes the remaining hole: every publisher method is
OPTIONAL, so a new event added to the port compiled fine with no implementation anywhere and would
have slipped past a guard that reflected an incomplete Noop.
