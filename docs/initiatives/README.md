# In-flight initiatives

**Everything in this directory describes work that is not finished.** An
initiative document is the tracker for a piece of multi-PR work: a cross-cutting
refactor, a registry-by-registry migration, a strangler conversion, a feature
too large to land in one change. It states the goal, the target pattern, a
per-item checklist updated as slices land, and the gotchas the pilot surfaced.

## How to read one

A tracker describes a **target state**, and at any moment some of it is built
and some is not. The checklist is the only honest account of which is which, so
read that before trusting the prose around it. Do not cite an initiative as a
description of how the platform behaves today; for that, use the reference docs
(`backend/docs/*.md`, `docs/*.md`, each package's `README.md`).

Trackers also earn their keep when an initiative is **redirected**, so a
document whose approach was withdrawn stays here on purpose: it is what stops
the next iteration from re-proposing it.

## Lifecycle

```
tracker lands with the first PR  →  slices land, checklist updated  →
  committed scope completes  →  converted to a numbered ADR, tracker deleted
```

When the committed scope completes, the tracker becomes an ADR under
[`backend/docs/adr/`](../../backend/docs/adr) (Context / Decision / Rationale /
Consequences, checklists dropped) and is `git rm`'d in the same PR. So the ADR
set is the record of what was decided and shipped, and this directory is
strictly the set of things still open. Several documents here are already cited
by [`CLAUDE.md`](../../CLAUDE.md) as the authority for a flow's design; that
makes them the best available account of the intent, not evidence the work is
done.

Full rules for when work earns a tracker: [`CLAUDE.md` → Bigger initiatives get
a tracker document](../../CLAUDE.md).

## Open initiatives

### Agents, pipelines and task types

- [Agent dependency prepopulation](./agent-dependency-prepopulation.md)
- [Auto-generated condensed briefs for best-practice standards](./auto-generated-fragment-briefs.md)
- [Binary outputs stored through foundational services](./binary-output-foundational-storage.md)
- [Bug-triage pipeline](./bug-triage-pipeline.md)
- [Configurable per-agent-kind output budgets](./configurable-agent-output-budgets.md)
- [Custom initiative definitions (org-registered presets)](./custom-initiative-definitions.md)
- [Judge registry (the verdict-gate family)](./judge-registry.md)
- [Library frame support](./library-frame-support.md)
- [Merge track record](./merge-track-record.md)
- [Persist, version and reseed fragment definitions](./fragment-definitions-reseed.md)
- [Pipeline catalog collapse (estimate-gated steps)](./pipeline-catalog-collapse.md)
- [Pipeline per-step options: one `step_options` bag](./pipeline-step-options.md)
- [PR verification report](./pr-verification-report.md)
- [PR-review token-burn reduction](./pr-review-turn-reduction.md)
- [Pre-PR validation checks](./pre-pr-validation.md)
- [Pre-dispatch input gate](./pre-dispatch-input-gate.md)
- [Ralph loop task type](./ralph-loop.md)
- [Service acceptance criteria](./service-acceptance-criteria.md)
- [Shared clarification-item abstraction](./clarification-items.md)
- [Headless clarification loop](./headless-clarification-loop.md)
- [Spike task support (research, no code)](./spike-task-support.md)

### Runtime, infrastructure and environments

- [App startup time reduction](./app-startup-optimization.md)
- [Caching layer](./caching-layer.md)
- [Connections between services](./service-connections.md)
- [Custom test-infrastructure provider autodetection](./custom-provider-autodetection.md)
- [Descriptor-driven infrastructure connect forms](./descriptor-driven-infra-forms.md)
- [Inline harness execution + preset satisfiability gate](./inline-harness-and-preset-satisfiability.md)
- [Mothership mode for local mode](./mothership-mode.md) ·
  [against a Cloudflare mothership](./mothership-cloudflare-host-gaps.md)
- [Performance optimizations (prioritized)](./performance-optimizations.md)
- [pg-boss ingestion optimization](./pg-boss-ingestion-optimization.md)
- [Run admission control (concurrency caps, queueing)](./run-admission-control.md)
- [Stack recipes and shared stacks](./stack-recipes-and-shared-stacks.md)
- [Tester environment access](./tester-environment-access.md)

### Spend, telemetry and operability

- [Observability, logging and error-handling gaps](./observability-logging-gaps.md)
- [Per-class token telemetry + cost surfacing](./token-telemetry-per-class-and-cost.md)
- [Per-model Bedrock enablement + per-preset provider preference](./model-provider-preference.md)
- [Per-run token-burn instrumentation](./token-burn-instrumentation.md)
- [Platform operator observability and alerting](./platform-operator-observability.md)
- [Spend forecasting, burn-rate and budget alerts](./spend-forecasting-and-alerts.md)
- [Stuck-run audit](./stuck-run-audit.md)
- [Token-usage and subscription-quota tracking](./usage-and-quota-tracking.md)

### Security and access control

- [Account audit log and session revocation](./audit-log-and-session-revocation.md)
- [Personal-PAT repo access + fail-closed frame redaction](./personal-pat-repo-access.md)
- [Security hardening pass](./security-hardening.md) ·
  [round 2](./security-hardening-round-2.md)
- [Workspace RBAC: security follow-ups](./workspace-rbac-security-followups.md)

### Frontend and UX

- [Error-message coverage](./error-message-coverage.md)
- [Frontend extension mechanism](./frontend-extension-mechanism.md)
- [GitLab product-surface parity](./gitlab-ui-parity.md)
- [Global search and deep-linkable routing](./global-search-and-deep-links.md)
- [Mobile-friendly frontend](./mobile-friendly-frontend.md)
- [modular-vue adoption](./modular-vue-adoption.md) ·
  [slice 5 progress](./modular-vue-slice5-progress.md)
- [UX papercuts](./ux-papercuts.md) ·
  [quality-of-life pass](./ux-qol-pass.md)

Four of the modular-vue slices are **upstream requests** written against the
`modular-react` / `modular-vue` libraries rather than against this repo, so they
track work that is not ours to land:
[pairing](./modular-vue-slice2-upstream-pairing.md) ·
[journeys](./modular-vue-slice3-upstream-journeys.md) ·
[zones](./modular-vue-slice4-upstream-zones.md) ·
[overlays](./modular-vue-slice5-upstream-overlays.md).

### API surface and integrations

- [Email as a NotificationChannel](./email-notification-channel.md)
- [Figma design support and the designer workflow](./figma-design-support.md)
- [MCP support maturation](./mcp-maturation.md)

### Engineering hygiene

- [Contracts parse-boundary test backfill](./contracts-test-backfill.md)
- [Ratchet down oxlint complexity and size ceilings](./lint-complexity-size-ratchet.md)
- [System audit: data lifecycle, runtime parity, robustness](./system-audit-improvements.md)
