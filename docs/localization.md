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

| Phase | Area                                                            | Components                                                                                                                             | Namespaces                                                               | Status                   |
| ----: | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------ |
|     0 | Pilot (error toasts, language switcher, personal subscriptions) | `usePipelineErrorToast`, `LanguageSwitcher`, `TranslationWarningBanner`, `PersonalSubscriptionSection`, `SideBar` (partial, uses `$t`) | `errors.*`, `language.*`, `personalSubscriptions.*`, `nav.*`, `common.*` | ✅ merged (pre-existing) |
|     1 | **Board**                                                       | `board/**` (15 components)                                                                                                             | `board.*`                                                                | ✅ merged (#393)         |
|     2 | **Inspector + step/observability panels**                       | `panels/**` + `panels/inspector/**` + `observability/**` (23 components)                                                               | `inspector.*`, `panels.*`, `observability.*`                             | ✅ merged (#395)         |
|     3 | **Layout + auth**                                               | `layout/**` (14) + `auth/**` (4)                                                                                                       | `layout.*`, `nav.*`, `auth.*`                                            | ✅ merged (#398)         |
|     4 | Settings                                                        | `settings/**` (12)                                                                                                                     | `settings.*`                                                             | ⬜ planned               |
|     5 | Providers + AI onboarding                                       | `providers/**` (5), provider banners                                                                                                   | `providers.*`                                                            | ⬜ planned               |
|     6 | Integrations: GitHub / Slack / documents / tasks                | `github/**`, `slack/**`, `documents/**`, `tasks/**`                                                                                    | `github.*`, `slack.*`, `documents.*`, `tasks.*`                          | ⬜ planned               |
|     7 | Pipeline + palette + gates                                      | `pipeline/**`, `palettes/**`, `gates/**`                                                                                               | `pipeline.*`, `palette.*`, `gates.*`                                     | ⬜ planned               |
|     8 | Agent windows                                                   | `requirements/`, `clarity/`, `consensus/`, `brainstorm/`, `spec/`, `followUp/`, `humanTest/`, `testing/`, `visualConfirm/`, `focus/`   | per-feature                                                              | ⬜ planned               |
|     9 | Remaining surfaces                                              | `bootstrap/`, `environments/`, `fragments/`, `kaizen/`, `sandbox/`, `recurring/`, `media/`, `provisioning/`                            | per-feature                                                              | ⬜ planned               |
|     X | Cross-cutting                                                   | `app/utils/catalog.ts` (status/agent-kind/block-type labels), `app/pages/*.vue`                                                        | `catalog.*` etc.                                                         | ⬜ planned               |

Rough scale: **~121 SPA components**; ~57 already resolve copy through i18n after
phases 0–3. The remaining work is the bulk of phases 4–X below.

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

The four board/panels components with **no** user-facing text — `AgentChip`,
`TaskDependencyEdges`, `DependencyConnectOverlay`, `StepResultViewHost` — need no
migration and are intentionally skipped.

### Remaining (by area)

**Settings** (phase 4)

```
settings/AccountSettingsPanel.vue, settings/IssueTrackerPanel.vue,
settings/LocalModeSettingsPanel.vue, settings/LocalModelEndpointsPanel.vue,
settings/MergeThresholdsPanel.vue, settings/ModelConfigurationPanel.vue,
settings/ObservabilityConnectionPanel.vue, settings/OpenRouterCatalogPanel.vue,
settings/ProviderConnectionPanel.vue, settings/ServiceFragmentDefaultsPanel.vue,
settings/UserSecretsSection.vue, settings/WorkspaceSettingsPanel.vue
```

**Providers** (phase 5)

```
providers/AiPresetMismatchDialog.vue, providers/AiProviderOnboardingModal.vue,
providers/ApiKeysSection.vue, providers/PersonalCredentialModal.vue,
providers/VendorCredentialsModal.vue
```

**Integrations** (phase 6)

```
github/AddServiceFromRepoModal.vue, github/GitHubConnect.vue, github/GitHubOnboarding.vue,
github/GitHubPanel.vue, github/RepoTreeBrowser.vue
slack/SlackPanel.vue
documents/ContextDocumentPicker.vue, documents/DocumentImportModal.vue,
documents/DocumentSourceConnectModal.vue, documents/SpawnPreviewModal.vue,
documents/TaskContextDocs.vue
tasks/ContextIssuePicker.vue, tasks/TaskContextIssues.vue, tasks/TaskImportModal.vue,
tasks/TaskSourceConnectModal.vue
```

**Pipeline / palette / gates** (phase 7)

```
pipeline/AgentKindIcon.vue, pipeline/IterationCapPrompt.vue, pipeline/PipelineBuilder.vue,
pipeline/PipelineHealthModal.vue, pipeline/PipelineProgress.vue
palettes/AgentPalette.vue
gates/GateResultView.vue
```

**Agent windows** (phase 8)

```
requirements/RequirementsReviewWindow.vue, clarity/ClarityReviewWindow.vue,
consensus/ConsensusSessionWindow.vue, brainstorm/BrainstormWindow.vue,
spec/ServiceSpecWindow.vue, followUp/FollowUpWindow.vue, humanTest/HumanTestWindow.vue,
testing/TestReportWindow.vue, visualConfirm/VisualConfirmationWindow.vue,
focus/BlockFocusView.vue
```

**Remaining surfaces** (phase 9)

```
bootstrap/BootstrapModal.vue, environments/EnvironmentStatusPanel.vue,
fragments/FragmentLibraryManager.vue, fragments/FragmentLibraryPanel.vue,
kaizen/KaizenPanel.vue, kaizen/KaizenStepStatus.vue, sandbox/SandboxPanel.vue,
recurring/RecurrenceEditor.vue, media/ArtifactLightbox.vue, media/ImageCompare.vue,
provisioning/ProvisioningLogsDrawer.vue
```

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
