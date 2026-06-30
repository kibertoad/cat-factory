# Localization (i18n) — status & plan

This document tracks the **app-wide internationalization migration** of the
`@cat-factory/app` Nuxt layer: moving every hard-coded user-facing string into
`@nuxtjs/i18n` message catalogs so the SPA can ship in multiple languages.

It is a **living status doc**. For the authoritative _how-to_ (catalog layout, the
add-a-string workflow, key conventions, plural/date/number rules, translator
descriptions, and the CI drift guards) see the **Internationalization (i18n)**
section of [`CLAUDE.md`](../CLAUDE.md) — this file does not duplicate those rules,
it only records **what is done and what is left**.

## TL;DR

- The migration is **incremental and phased**. Each phase localizes one area of the
  app, lands the new keys in **all five bundled locales**, and ships as its own PR.
- **Bundled locales:** `en` (source) + `es`, `fr`, `pl`, `uk`. Every new key must
  exist in **all five** or the `i18n:check` CI gate fails (it hard-fails on a key
  used in code but missing from a catalog).
- Catalogs live in `frontend/app/i18n/locales/<locale>.json`; runtime vue-i18n
  behaviour (fallback, plural rules, number/date formats) is in
  `frontend/app/i18n/i18n.config.ts`.

## Progress

| Phase | Area                                                            | Components                                                                                                                                  | Namespaces                                                                                                          | Status                   |
| ----: | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------ |
|     0 | Pilot (error toasts, language switcher, personal subscriptions) | `usePipelineErrorToast`, `LanguageSwitcher`, `TranslationWarningBanner`, `PersonalSubscriptionSection`, `SideBar` (partial, uses `$t`)      | `errors.*`, `language.*`, `personalSubscriptions.*`, `nav.*`, `common.*`                                            | ✅ merged (pre-existing) |
|     1 | **Board**                                                       | `board/**` (15 components)                                                                                                                  | `board.*`                                                                                                           | ✅ merged (#393)         |
|     2 | **Inspector + step/observability panels**                       | `panels/**` + `panels/inspector/**` + `observability/**` (23 components)                                                                    | `inspector.*`, `panels.*`, `observability.*`                                                                        | ✅ merged (#395)         |
|     3 | **Layout + auth**                                               | `layout/**` (14) + `auth/**` (4)                                                                                                            | `layout.*`, `nav.*`, `auth.*`                                                                                       | ✅ merged (#398)         |
|     4 | **Settings**                                                    | `settings/**` (12)                                                                                                                          | `settings.*`                                                                                                        | ✅ merged (#401)         |
|     5 | **Providers + AI onboarding**                                   | `providers/**` (5)                                                                                                                          | `providers.*`                                                                                                       | ✅ merged (#403)         |
|     6 | **Integrations: GitHub / Slack / documents / tasks**            | `github/**` (5), `slack/**` (1), `documents/**` (5), `tasks/**` (4)                                                                         | `github.*`, `slack.*`, `documents.*`, `tasks.*`                                                                     | ✅ merged (#411)         |
|     7 | **Pipeline + palette + gates**                                  | `pipeline/**` (5), `palettes/**` (1), `gates/**` (1)                                                                                        | `pipeline.*`, `palette.*`, `gates.*`                                                                                | ✅ done (this PR)        |
|     8 | **Agent windows**                                               | `requirements/`, `clarity/`, `consensus/`, `brainstorm/`, `spec/`, `followUp/`, `humanTest/`, `testing/`, `visualConfirm/`, `focus/`        | per-feature                                                                                                         | ✅ done (this PR)        |
|     9 | **Remaining surfaces**                                          | `bootstrap/` (1), `environments/` (1), `fragments/` (2), `kaizen/` (2), `sandbox/` (1), `recurring/` (1), `media/` (2), `provisioning/` (1) | `bootstrap.*`, `environments.*`, `fragments.*`, `kaizen.*`, `sandbox.*`, `recurring.*`, `media.*`, `provisioning.*` | ✅ done (this PR)        |
|     X | Cross-cutting                                                   | `app/utils/catalog.ts` (status/agent-kind/block-type labels), `app/pages/*.vue`                                                             | `catalog.*` etc.                                                                                                    | ⬜ planned               |

Rough scale: **~121 SPA components**; ~117 already resolve copy through i18n after
phases 0–9. The remaining work is phase X (cross-cutting) below.

### Done

- **Phase 0 (pilot):** the conflict-toast error mapping (`usePipelineErrorToast`),
  the language switcher + unofficial-translation banner, the personal-subscriptions
  section, and the shared `common.*` / `nav.*` / `errors.*` vocabulary.
- **Phase 1 (board, #393):** the canvas empty state + drop toasts, the toolbar
  (level-of-detail readout, spend indicator via the vue-i18n number formatter,
  decision/service controls), the add-task and recurring-pipeline modals, the
  service/module frames, task cards, epic nodes, decision/approval badges, and the
  shared agent failure/stop controls.
- **Phase 2 (panels + inspector, #395):** the inspector tabs (container/service
  summary, epic children, recurring schedule, fragments, release-health config,
  test-infra config, agent config, dependencies, estimate, the execution pipeline
  list, run settings, task structure), the step-detail overlay (review/approve +
  conclusion editing), decision modal, generic structured result view, test report,
  step metadata/run-meta cards, restart control, and the model-activity /
  provided-context observability panels.
- **Phase 3 (layout + auth, #398):** the auth screens (login / signup / forgot,
  reset-password, the auth gate, the user menu), and the layout surfaces — the
  account-level deployment / fragment / team settings, the AI-providers / GitHub-PAT
  / provider-config / spend-warning banners, the board switcher, the command bar
  (command labels + search keywords), the integrations hub (status, groups, per-item
  labels), the integration back-title, the notifications inbox (per-type actions),
  and the personal-setup modal. `SideBar.vue` is now fully migrated (switched off the
  global `$t` to the destructured `t`). New keys under `auth.*` and `layout.*`, in all
  five bundled locales.
- **Phase 4 (settings, #401):** the model-configuration presets editor, account
  settings tabs, the provider-connection panel (environment + runner-pool, local
  delegation), service fragment defaults, the issue-tracker panel (filing / linking /
  writeback), user secrets, merge-threshold presets, the observability connection +
  incident enrichment, local-mode tuning (warm pool + checkout reuse), the OpenRouter
  catalog, the workspace settings (waiting / task-limit / observability / retention /
  Kaizen / budget), and the local model endpoints. 314 keys under `settings.*` in all
  five locales (enum-keyed lookups via exhaustive `Record` maps; spend currency via the
  number formatter).

- **Phase 5 (providers, #403):** the default-preset mismatch dialog and the AI-provider
  onboarding modal (the provider-keys / OpenRouter / local-runner routes), the personal
  individual-usage credential prompt (reason-keyed title + connect-vs-unlock flows), the
  direct/proxy provider API-keys section (per-vendor labels + guided steps, scope/provider
  pickers, the caching note, connected-key usage), and the pooled LLM-vendor credentials
  modal (tabs, pool intro, per-vendor guided steps, connected-token usage). New keys under
  `providers.*` in all five bundled locales; connected-key/token usage uses plural forms
  (3-form for pl/uk) with the number formatter, and per-vendor labels/steps resolve via
  literal `t(...)` keys to keep the typed-key drift guard live.

- **Phase 6 (integrations, this PR):** the GitHub surfaces (the onboarding gate, the
  installation connect flow, the integration panel's repos/pulls/issues browsing, the
  add-service-from-repo modal, the repo tree browser), the Slack routing/members panel
  (routable notification-type labels + role options), the documents surfaces (context-doc
  picker, import modal, source-connect modal, spawn preview, task context-docs list), and
  the tasks/issue-tracker surfaces (context-issue picker, context-issues list, import
  modal, source-connect modal). New keys under `github.*`, `slack.*`, `documents.*` and
  `tasks.*` in all five bundled locales (256 leaf keys total, full parity); count readouts
  use plural forms (3-form for pl/uk), statically-known enum labels (PR/issue state, Slack
  notification types) resolve via literal `t(...)` keys to keep the typed-key drift guard
  live, and structural emphasis uses `<i18n-t>` slots instead of HTML in message bodies.

- **Phase 7 (pipeline + palette + gates, this PR):** the pipeline builder slideover (agent
  palette, draft chain with the per-step companion/approval/consensus/follow-up toggles and
  their tooltips, estimate-gating thresholds, the consensus strategy picker + participants,
  the saved-pipeline library with archive/clone/edit and label filters, the add-agent
  modal, and every toast), the pipeline-progress timeline (instance/step status labels,
  background review stages, subtask + follow-up readouts, restart controls, the approval /
  decision prompts), the pipeline-health advisory (invalid / outdated sections, reseed /
  delete actions), the agent palette (hint + custom bucket), the shared iteration-cap prompt
  (the three default choice labels), and the gate result window (CI / conflicts / human-review
  variants — subtitles, the rolled-up display status, failing-check list, approval progress,
  the request-a-fix box, attempt timeline, and the sidebar state/budget/footer). New keys
  under `pipeline.*`, `palette.*` and `gates.*` in all five bundled locales (166 leaf keys,
  full parity); count readouts use plural forms (3-form for pl/uk) with the count selector,
  the local status/state/strategy/outcome enum lookups resolve via exhaustive `Record` maps
  of literal `t(...)` keys to keep the typed-key drift guard live, the "agents complete"
  count uses an `<i18n-t>` slot for its bold figure, and timestamps go through `d(...)`.
  `pipeline/AgentKindIcon.vue` resolves all its copy from the shared catalog (deferred to
  phase X), so it carries no own strings and needs no migration. The composable-produced
  `usePipelineHealth` problem messages stay English for now (they mirror backend validation
  and are out of the component scope; their unit test asserts on `type`, not text).

- **Phase 8 (agent windows, this PR):** the ten dedicated agent result/decision windows —
  the requirements-review window (the answer/dismiss → incorporate → re-review/redo →
  proceed loop, "Iteration N / M", the exceeded 3-choice prompt via the shared
  `IterationCapPrompt`), the clarity and brainstorm review loops (intro emphasis via
  `<i18n-t>` slots, severity/category/status badges, re-review toasts), the consensus
  session view (strategy/round/status enums, anonymized "Expert A" labels, confidence
  percentage), the service-spec window (view-mode toggle, priority/kind chips, Gherkin
  keywords kept verbatim, module-count plurals), the follow-up companion, the human-test
  and visual-confirmation gates (phase/outcome/env-status enums, round-history plurals,
  expiry dates via `d(...)`), the test-report window (status/severity enums, screenshot /
  check / concern count plurals), and the block focus view. New keys under `requirements.*`,
  `clarity.*`, `consensus.*`, `brainstorm.*`, `spec.*`, `followUp.*`, `humanTest.*`,
  `testing.*`, `visualConfirm.*` and `focus.*` in all five bundled locales (full parity);
  plural readouts use 3 forms for pl/uk, enum lookups resolve via exhaustive `Record` maps
  of literal `t()` keys, percentages via `n(..., 'percent')`. `catalog.ts`-sourced
  status/type labels rendered in these windows stay deferred to phase X.

- **Phase 9 (remaining surfaces, this PR):** the repo-bootstrap modal (launch form with
  the reference/scratch mode picker, repo-name validation errors, the create-repo /
  grant-access flows, visibility + instruction fields, the recent-runs list with status
  badges, and the reference-architecture CRUD form), the Sandbox window (the
  experiment-matrix builder with cell-count plurals, the results grid + experiment/run
  status enums, the prompt fork/version editor, the fixtures list with kind/origin enums
  and expectation-count plurals, the unavailable/error notices via `<i18n-t>` code slots,
  and every toast), the prompt-fragment library (the manager's four tabs — resolved
  catalog with a fragment-count plural, hand-authored, document-backed and repo-source
  fragments, every placeholder + toast — plus the board-scope panel shell), the Kaizen
  screen (verified-combos + grading-history tables, status enums, grade readouts) and its
  per-step grading card, the recurrence editor (weekday abbreviations, hour-window
  toggle, timezone), the ephemeral-environment status panel (status enum + expiry via
  `d(...)`), the provisioning-logs drawer (operation/outcome enums, timestamps), and the
  media surfaces — the actual-vs-reference comparator (mode labels, alt text, upload
  hints) and the screenshot lightbox (toolbar titles, counter, zoom percentage via
  `n(..., 'percent')`). New keys under `bootstrap.*`, `sandbox.*`, `fragments.*`,
  `kaizen.*`, `recurring.*`, `environments.*`, `provisioning.*` and `media.*` in all five
  bundled locales (full parity); plural readouts use 3 forms for pl/uk, enum lookups
  resolve via exhaustive `Record` maps of literal `t()` keys, and concrete example
  placeholders (`payments-service`, `acme`, the `e.g. …` hints) stay inline per the
  convention. `agentKindMeta`/`STATUS_META`-sourced labels rendered in these surfaces
  stay deferred to phase X.

The four board/panels components with **no** user-facing text — `AgentChip`,
`TaskDependencyEdges`, `DependencyConnectOverlay`, `StepResultViewHost` — need no
migration and are intentionally skipped.

### Remaining (by area)

**Cross-cutting** (phase X)

- `app/utils/catalog.ts` — the shared `STATUS_META`, `agentKindMeta`, `blockTypeMeta`,
  `MODULE_META` label/description tables are rendered across many components but are
  still raw English. Several already-migrated components fall back to these (e.g. a
  task card's generic status label). Localizing them (an enum→key lookup, tier-2
  guarded) removes the last raw strings from the board/inspector surfaces.
- `app/pages/index.vue`, `app/pages/reset-password.vue` — page-level copy.

## Per-phase checklist

For each phase (see `CLAUDE.md` → Internationalization for the full rules):

1. Replace every user-facing string (visible text, `placeholder`, `title`/tooltip,
   `aria-label`, button labels, toast `title`/`description`, script-built labels)
   with `t(...)` under the phase's namespace. Destructure `const { t } = useI18n()`
   (plus `d`/`n` as needed); use `t` in templates, not `$t`.
2. Plurals via `t(key, { count }, count)`; dates via `d(value, 'short'|'long')`;
   numbers/percent/currency via `n(value, { key, currency })`. Inline-styled values
   via `<i18n-t>` slots. Enum→key lookups via an **exhaustive `Record`** of literal
   key strings.
3. Add the new keys to `en.json`, then **all four** of `es/fr/pl/uk.json` (real
   translations, 3 plural forms for pl/uk). Keep keys in full parity across locales.
4. Verify: `pnpm --filter @cat-factory/app run i18n:check` (no missing keys),
   `pnpm exec turbo run typecheck --filter=@cat-factory/app` (typed message keys),
   `pnpm exec turbo run test:run --filter=@cat-factory/app`, and `oxfmt --check`.
5. Add a changeset (`@cat-factory/app` patch) and open a PR off the latest `main`.

## Known issues

- **Pre-existing typecheck breakage on `main` (now resolved):** PR #372 had left
  `nuxt typecheck` reporting ~150 errors in untouched `app/composables/api/*.ts`
  files (HTTP-client typings). As of phase 3, a clean `main` checkout typechecks
  with zero errors again, so the gate is green; the i18n migration continues to add
  zero new type errors.
