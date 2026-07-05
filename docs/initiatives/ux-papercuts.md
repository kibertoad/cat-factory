# UX papercuts & improvements — audit + fix tracker

Status: **fixes in progress.** Slices landed: the undo & confirmation-blast-radius
cluster (UX-01/02/03/13, [#737](https://github.com/kibertoad/cat-factory/pull/737)); the
clipboard-feedback shared primitive (UX-38/39); friendly model/agent-kind labels in the
review & consensus windows (UX-36/37); markdown prose + copy affordances in the result
views (UX-43, UX-44 copy buttons); the review-window gate-actions + draft-persistence
cluster (UX-32/33/34); the async-state / realtime / error-surfacing section E in full
(UX-70..UX-77 — offline indicator, retrying refresh/resync, self-healing preview poll,
retry affordances, sticky remedy toasts). This
document catalogs UX papercuts
(small annoyances, missing affordances, rough edges) found in the SPA
(`frontend/app/app`) during a systematic sweep on 2026-07-02. Every finding was
verified against the code at the referenced `file:line` (line numbers drift as the
tree moves — treat them as anchors, not gospel).

## Goal & rationale

The product's core flows (board, pipelines, review gates, integrations) are
functionally solid, but a layer of small UX debt accumulates friction: destructive
actions without undo, silently lost input, unlabeled controls, silent failures.
Each item is individually cheap; together they define the difference between
"works" and "feels good". The intent is to burn these down incrementally —
a handful per PR, grouped by area — using the checklist below as the durable
source of truth across iterations.

**How to use this doc:** pick a cluster of `todo` items (ideally one section, or one
cross-cutting theme), fix them in one PR, flip their status to `done` with a PR
link, and carry any new conventions into the _Conventions_ section at the bottom.

## Severity legend

- **P1** — actively loses user data/work, blocks a flow, or hides a required action.
- **P2** — misleads the user, forces workarounds, or is a systemic inconsistency.
- **P3** — polish; low individual impact but compounding.

## Cross-cutting themes

These recur across many components; fixing them wants a shared primitive, not
per-file patches:

1. **No undo, and confirmations that undersell blast radius** (UX-01, UX-02, UX-03,
   UX-52). The rollback snapshot machinery already exists in `stores/board.ts` —
   undo is one toast-action away.
2. **Typed input silently discarded** on Escape/backdrop-close of modals and review
   windows, and on settings tab switches (UX-18, UX-33, UX-58). Wants a shared
   dirty-check + confirm-before-discard seam on the modal primitive.
3. **Secrets UX is inconsistent** — some fields are masked, some are plaintext
   textareas, none have a reveal toggle, keys are saved unvalidated and displayed
   without identity hints (UX-19, UX-20, UX-45, UX-46, UX-47).
4. **Icon-only buttons without accessible names / tooltips** — no single convention;
   coverage is accidental (UX-62, UX-63). Wants an `IconButton` wrapper or a lint rule.
5. **Clipboard actions without feedback** and error surfaces without copy buttons
   (UX-38, UX-39). One good pattern exists (`StepContainerStatus.vue`) — reuse it.
6. **Silent async failure paths**: swallowed refreshes, polling that stops forever,
   error states with no retry (UX-70..UX-76).
7. **Raw internal identifiers leaking into UI** — model ids, agent-kind enums,
   backend error prose (UX-36, UX-37, UX-57).

---

## A. Board & canvas

| ID    | Sev | Status      | Finding                                                                       |
| ----- | --- | ----------- | ----------------------------------------------------------------------------- |
| UX-01 | P1  | done (#737) | No undo after a successful block delete                                       |
| UX-02 | P1  | done (#737) | Delete confirmation never states cascade scope                                |
| UX-03 | P1  | done (#737) | Accidental drag-reparent commits silently, no undo                            |
| UX-04 | P2  | todo        | Drag/reparent has no drop-target highlighting                                 |
| UX-05 | P2  | todo        | Dependency drag-to-connect: no target highlight, silent no-op on invalid drop |
| UX-06 | P2  | todo        | Dependency edges cannot be removed (or hovered) on the canvas                 |
| UX-07 | P2  | todo        | Pipeline dropped on blank canvas gives no feedback                            |
| UX-08 | P2  | todo        | Zoom / fit-view toolbar buttons lack tooltips; `maximize` glyph ambiguous     |
| UX-09 | P2  | todo        | Double-clicking a frame/epic is a dead no-op                                  |
| UX-10 | P2  | todo        | Selection, zoom, viewport lost on reload / workspace switch                   |
| UX-11 | P2  | todo        | Camera doesn't refit on workspace switch                                      |
| UX-12 | P2  | todo        | No arrow-key navigation or keyboard block movement                            |
| UX-13 | P2  | done (#737) | Hardcoded English toast `'Could not move'` in `moveBlock`                     |
| UX-14 | P3  | todo        | No reset-zoom-to-100%; zoom readout not clickable                             |
| UX-15 | P3  | todo        | Zoom/LOD readout hidden below `sm` breakpoint                                 |
| UX-16 | P3  | todo        | Zoom buttons don't disable at min/max                                         |
| UX-17 | P3  | todo        | Desktop frame-resize grips are an 8px hit target                              |

- **UX-01 — No undo after delete. DONE.** `stores/board.ts` `removeBlock` now
  **defers** the backend delete by a `UNDO_WINDOW_MS` (6s) window and shows a
  "Deleted X — Undo" toast whose action cancels the pending call and `reattach`es the
  subtree — a genuine undo, since nothing was destroyed server-side yet. The pending
  subtree is filtered out of every `hydrate`/`upsert` (`applyPendingRemovals` +
  `pendingDoomed`) so a coarse refresh or stray live event can't resurrect it, and the
  deferred call captures the workspace id so a mid-window switch still deletes the right
  board. (The recurring-pipeline delete path keeps its immediate-delete semantics.)
- **UX-02 — Cascade scope not stated. DONE.** `useBlockDeletion.copyFor` now reads a
  pure `board.descendantsOf(id)` count (added to `useBlockQueries`) and, for a non-empty
  container, uses the pluralized `confirmDelete.containerBodyWithCount` so the confirm
  states the exact number of items that go with it.
- **UX-03 — Silent drag-reparent. DONE.** A successful `reparentBlock` into a
  _different_ container now offers the same "Moved X — Undo" toast, moving the block back
  to its previous parent + position (the undo move is itself non-undoable so the toast
  doesn't ping-pong). Covers the drag-overshoot-into-a-neighbour case.
- **UX-04 — No drop-target highlight.** `useBlockDrag.ts:69-92`,
  `components/board/BoardCanvas.vue:113-116`. Destination resolved via
  `elementFromPoint` _on release only_; nothing highlights the hovered drop zone
  during the drag. Fix: a `hoveredDropZoneId` ref driving a ring (mirror the
  `useFrameStacking` hover pattern).
- **UX-05 — Dependency connect is blind.** `composables/useDependencyConnect.ts:33-49`.
  No candidate-card highlight while dragging; release over a non-task / same task
  silently `return`s. Fix: highlight hovered task, toast on invalid drop.
- **UX-06 — Edges not removable on canvas.**
  `components/board/TaskDependencyEdges.vue:163` — the whole SVG overlay is
  `pointer-events-none`. Removal requires re-running the exact same drag
  (`toggleDependency`), which is undiscoverable. Fix: clickable edge with hover "×".
- **UX-07 — Silent failed pipeline drop.** `BoardCanvas.vue:138-160`. Wrong-level and
  dependency-blocked drops toast, but `if (!target || !pipeline) return` swallows a
  drop on empty canvas. Fix: "Drop a pipeline onto a task" toast.
- **UX-08 — Untitled zoom controls.** `components/layout/BoardToolbar.vue:102-130`.
  `zoom-in`/`zoom-out`/`i-lucide-maximize` (fit-to-content, reads as "fullscreen")
  have no `:title`/aria-label, unlike the frame-header buttons.
- **UX-09 — Dead double-click.** `BoardCanvas.vue:103-106` calls `ui.toggleFrame`,
  but `BlockNode.vue:78` hardcodes `showExpanded = true` and
  `ui.isFrameExpanded()` (`stores/ui.ts:262-264`) always returns `true` — the toggle
  gates nothing. Remove the handler or repurpose (e.g. zoom-to-fit the frame).
- **UX-10 — Transient view state.** `stores/ui.ts:34,239,244` — `selectedBlockId`,
  `zoom`, `expandedFrames` are plain refs; `BoardCanvas.vue:178-181` only does
  `fit-view-on-init`. Fix: persist per-workspace (localStorage).
- **UX-11 — No refit on workspace switch.** `BoardCanvas.vue:181`. Switching
  workspaces swaps frames without re-fitting; user can land on empty canvas and
  think the workspace is blank. Fix: `fitView()` on workspace change.
- **UX-12 — No keyboard spatial actions.** `composables/useKeyboardShortcuts.ts:50-80`
  implements only Escape / Delete / `?`. No arrow-key traversal or nudge; every
  spatial action requires a pointer. (See also UX-69.)
- **UX-13 — Un-i18n'd move-failure toast. DONE.** `moveBlock`'s failure toast now uses
  `tr('board.toast.moveFailed')` (the key already existed) instead of the literal
  `'Could not move'`.
- **UX-14/15/16 — Zoom polish.** `BoardToolbar.vue:102-130` + `BoardCanvas.vue:176-177`:
  readout is static text (make it click-to-reset-100%), hidden below `sm`, and the
  buttons stay enabled-but-inert at the 0.2/3.0 clamps.
- **UX-17 — Tiny resize grips.** `components/board/nodes/ModuleFrame.vue:83-91`,
  `BlockNode.vue:515-528` — `w-2`/`h-2` (8px) grips, widened only for
  `pointer-coarse:`. Add a larger invisible hit area for fine pointers.

## B. Modals, forms & inputs

| ID    | Sev | Status | Finding                                                                            |
| ----- | --- | ------ | ---------------------------------------------------------------------------------- |
| UX-18 | P1  | todo   | Content-heavy modals discard all typed input on Escape/backdrop click              |
| UX-19 | P2  | todo   | No show/hide toggle on any password/secret field (systemic)                        |
| UX-20 | P2  | todo   | Provider API key entered in a plaintext, unmasked textarea (several surfaces)      |
| UX-21 | P2  | todo   | `unlinkSource` (fragment library) destroys a synced source with no confirmation    |
| UX-22 | P2  | todo   | Reset-password validation is submit-only, no inline feedback                       |
| UX-23 | P2  | todo   | Slack member-mapping rows keyed by index; incomplete rows silently dropped on save |
| UX-24 | P2  | todo   | Datadog connection can't be updated without re-pasting both write-only keys        |
| UX-25 | P2  | todo   | DecisionModal options: fire-and-forget, no pending state, double-click hazard      |
| UX-26 | P3  | todo   | No autofocus on first field of login/reset/connect modals                          |
| UX-27 | P3  | todo   | Disabled submit buttons don't state why (min-length rules invisible)               |
| UX-28 | P3  | todo   | No character counters where the backend enforces length limits                     |
| UX-29 | P3  | todo   | Fragment library: one global loading flag spins every row's buttons                |
| UX-30 | P3  | todo   | Slack "Add to Slack" OAuth button has no pending state                             |
| UX-31 | P3  | todo   | "Edit" on list items doesn't scroll/focus the offscreen edit form                  |

- **UX-18 — Dirty modals discard input.** `components/board/AddTaskModal.vue`
  (open computed :34-39, reset watcher :321-358) — Escape or backdrop click wipes
  title, description, per-type fields, and attached context docs/issues. Same
  pattern: `RecurringPipelineModal.vue:19-24`, `bootstrap/BootstrapModal.vue:20-25`,
  credential modals. Fix: dirty flag + confirm-before-discard, or
  non-dismissible-when-dirty. This is the single most damaging papercut for
  heavy users. (Review-window variant: UX-33; settings variant: UX-58.)
- **UX-19 — No reveal toggle.** Bare `type="password"` with no eye toggle at:
  `auth/LoginScreen.vue:323,394`, `auth/ResetPasswordScreen.vue:79,88`,
  `documents/DocumentSourceConnectModal.vue:108`, `settings/UserSecretsSection.vue:210-215`,
  `settings/ObservabilityConnectionPanel.vue:197-210,257,268`,
  `settings/LocalModelEndpointsPanel.vue:275`, `slack/SlackPanel.vue:189-195`,
  `providers/PersonalCredentialModal.vue:114`. Users pasting long tokens can't
  verify them — a leading cause of invalid-credential retries. Fix: shared
  trailing-slot eye toggle on `UInput`.
- **UX-20 — Plaintext secret textareas.** `providers/ApiKeysSection.vue:325-333`,
  `providers/VendorCredentialsModal.vue:217-224`,
  `settings/OpenRouterCatalogPanel.vue:278-285`,
  `providers/PersonalSubscriptionSection.vue:235-243` — live vendor keys render
  fully visible (shoulder-surf / screen-share leakage), inconsistent with the
  masked fields in UX-19's list. Fix: mask by default + reveal toggle.
- **UX-21 — Unguarded unlink.** `fragments/FragmentLibraryManager.vue:233-240`
  (button :502-508) fires immediately, while sibling `removeFragment` (:124-140)
  routes through `confirm()`. Fix: same confirm dialog.
- **UX-22 — Submit-only validation.** `auth/ResetPasswordScreen.vue:21-30` — the
  length≥8 and match checks run only on submit; no live hint or match indicator.
- **UX-23 — Fragile Slack mapping rows.** `slack/SlackPanel.vue:292` (`:key="i"`)
  - save filter at `:151`. Deleting a middle row can misbind `v-model`s; rows
    missing either id are silently dropped on save. Fix: stable keys + block/warn on
    incomplete rows.
- **UX-24 — Datadog forced re-entry.** `settings/ObservabilityConnectionPanel.vue:216-219`
  disables save unless both write-only keys are present, so changing only `site`
  requires re-pasting both secrets — while the panel's own incident section (:75)
  supports "blank = keep existing". Fix: same blank-keeps semantics.
- **UX-25 — DecisionModal double-submit.** `panels/DecisionModal.vue:26-30` —
  `choose()` neither awaits `execution.resolveDecision` nor disables options and
  closes immediately; a failed resolve closes silently, and a fast double-click can
  dispatch two resolutions. Fix: local `resolving` flag, await, surface errors.
  (Independently flagged by two audit passes.)
- **UX-26 — Missing autofocus.** `LoginScreen.vue:314`, `ResetPasswordScreen.vue:79`,
  `DocumentSourceConnectModal`, `DocumentImportModal`, `BootstrapModal` first
  inputs. Good counter-examples: `AddTaskModal:472`, `RecurringPipelineModal:147`.
- **UX-27 — Unexplained disabled buttons.** `PersonalCredentialModal.vue:126`
  (`password.length < 6`), `PersonalSubscriptionSection.vue:107,260`,
  `ResetPasswordScreen` — greyed submit with no "minimum N characters" helper text.
- **UX-28 — No counters on bounded fields.** `bootstrap/BootstrapModal.vue:90-97`
  errors on repo-name >100 chars but the input has no `maxlength`/counter;
  description/instructions have neither.
- **UX-29 — Global loading flag.** `FragmentLibraryManager.vue` — every row's
  sync/refresh button binds `:loading="library.loading"` (:399, :499), so one
  action spins all rows; `checkSource`/`unlinkSource` (:493, :502-508) show no
  loading at all. Fix: track in-flight row id.
- **UX-30 — Inert OAuth button.** `SlackPanel.vue:176-183` awaits `installUrl()`
  with no `:loading` (paste-token button beside it does it right).
- **UX-31 — Edit without focus move.** `LocalModelEndpointsPanel.vue:228`,
  `UserSecretsSection` — "edit" mutates state but the form is below a long list;
  on small viewports the click appears to do nothing. Fix: scroll-into-view + focus.

## C. Review windows, inspector & pipeline surfaces

| ID    | Sev | Status  | Finding                                                                                                          |
| ----- | --- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| UX-32 | P1  | done    | Requirements/Clarity review actions completely hidden below `lg` — gate unadvanceable                            |
| UX-33 | P1  | done    | Typed review answers lost when window closes without blur/save                                                   |
| UX-34 | P2  | done    | Requirements auto-saves on blur; Clarity needs explicit "Save answer" — opposite models                          |
| UX-35 | P2  | todo    | No elapsed time on running steps in PipelineProgress / TaskExecution                                             |
| UX-36 | P2  | done    | Raw model id rendered verbatim in review windows                                                                 |
| UX-37 | P2  | done    | Internal `agentKind` enum + raw model id leak in consensus window                                                |
| UX-38 | P2  | done    | Clipboard copies give no feedback and swallow failures                                                           |
| UX-39 | P2  | done    | Agent/provider errors have no copy button                                                                        |
| UX-40 | P2  | todo    | Inspector "Run" disabled with no explanation                                                                     |
| UX-41 | P2  | todo    | Stopping a running bootstrap has no confirmation                                                                 |
| UX-42 | P3  | todo    | "Restart from here" only visible on hover (invisible on touch)                                                   |
| UX-43 | P3  | done    | Agent prose rendered as plain text in several result views                                                       |
| UX-44 | P3  | partial | Structured JSON / consensus output lack copy buttons; no jump-to-latest in live stream; findings lack timestamps |

- **UX-32 — Hidden gate actions. DONE.** The action rail in both
  `RequirementsReviewWindow.vue` and `ClarityReviewWindow.vue` was `<aside class="hidden
w-72 … lg:flex">`, so below `lg` (laptop split-screen, tablet) the human could answer
  findings but had no visible way to advance the gate. The `aside` is now a responsive
  rail — a right-hand column on wide screens (`lg:w-72 lg:border-s`) and a full-width
  bottom action bar below `lg` (`flex w-full border-t`, never hidden). The
  purely-informational stats block is the only thing hidden below `lg`
  (`hidden … lg:block`) so the mobile action bar stays compact; every action button shows
  at all sizes. (The `exceeded` state's `IterationCapPrompt` was already in the main
  column, so it was reachable — the fix is for the `ready`/`merged` actions +
  request-recommendations.)
- **UX-33 — Lost review drafts. DONE.** `useResultView` gained an `onClose` hook that
  runs on EVERY close path (X, backdrop, Escape) before the view tears down; both review
  windows pass `onClose: () => void flushDrafts()`. `flushDrafts` now snapshots the review
  up front and threads it through `persistDraft`, so the persist completes even though the
  reactive `review`/`blockId` go null the instant the view closes.
- **UX-34 — Inconsistent save models. DONE.** The clarity window was converted to
  auto-save-on-blur (the requirements pattern): a seeding `watch` pre-fills each textarea
  from the recorded reply, `persistDraft` saves on `@blur` only when the trimmed draft
  differs, and the explicit "Save answer" button (+ its `clarity.saveAnswer` /
  `clarity.refineAnswerPlaceholder` i18n keys, removed from all 8 locales) is gone. Both
  windows now behave identically.
- **UX-35 — No elapsed clock.** `pipeline/PipelineProgress.vue` and
  `panels/inspector/TaskExecution.vue` show spinner/phase/subtasks but no duration;
  `composables/useStepTimer.ts` is wired only into the step-detail overlay. A step
  that hasn't emitted subtasks reads as hung. Fix: surface `durationLabel` inline
  on the active step.
- **UX-36 — Raw model ref. DONE.** `RequirementsReviewWindow.vue` and
  `ClarityReviewWindow.vue` now render the reviewer model via
  `models.labelForRef(review.model) ?? review.model` (the friendly `<label> · <provider>`
  string the pipeline surfaces use — `StepMetadataCard`/`StepRunMeta`), falling back to the
  bare ref when the catalog hasn't loaded.
- **UX-37 — Consensus leaks internals. DONE.** `consensus/ConsensusSessionWindow.vue` renders
  the session subtitle via `agentKindMeta(session.agentKind).label` and each participant's
  model via `models.labelForRef(p.modelId) ?? p.modelId` instead of the raw enum / raw
  `modelId`.
- **UX-38 — Silent clipboard. DONE.** `StepContainerStatus.vue`'s copy-with-toast pattern
  is extracted into the shared `useCopyToClipboard()` composable (VueUse `useClipboard` +
  a success/failure toast; it only claims success once the write actually landed). Every
  silent site now routes through it: `StepMetadataCard.vue`/`StepRunMeta.vue` (`copyRunId`),
  `AgentStepDetail.vue` (`copyOutput`), `KubernetesEngineForm.vue` (auto-setup command), and
  `StepContainerStatus.vue` itself is refactored onto the composable so the duplication is gone.
- **UX-39 — Uncopyable errors. DONE.** A reusable `common/CopyButton.vue` (title + aria-label,
  routed through `useCopyToClipboard`) puts a copy affordance on the failure surfaces: the
  `FailureDetail.vue` stack-trace `<pre>` (so both `AgentFailureCard` and `AgentFailureHistory`
  get it), the consensus failure banner (`ConsensusSessionWindow.vue`, when there's an error
  string), and the gate failure summary (`GateResultView.vue`, both the human-review and
  conflicts blocks).
- **UX-40 — Unexplained lock.** `panels/InspectorPanel.vue:493-504` — when
  `!runnable` the run trigger becomes a disabled lock icon with no tooltip stating
  the blocking condition (unmet dependency, wrong status, …).
- **UX-41 — Unguarded bootstrap stop.** `InspectorPanel.vue:386` +
  `AgentStopButton.vue:29` kill the container immediately on click, while the
  comparable task reset is confirm-gated (`TaskExecution.vue:148-159`).
- **UX-42 — Hover-only restart.** `PipelineProgress.vue:325` styles the restart
  button `opacity-0 group-hover:opacity-100` — invisible on touch, no focus
  affordance. Fix: also reveal on `focus-within`, or always show dimmed.
- **UX-43 — Markdown as plain text. DONE.** A new shared `renderMarkdown()`
  (`utils/agentOutput.ts` — the same secure markdown-it config as the reader, `html:false`,
  links decorated to open safely) plus a reusable `common/MarkdownProse.vue` component replace
  the `whitespace-pre-wrap` dumps in `GenericStructuredResultView.vue` (prose summary),
  `MergerResultView.vue` (rationale + pre-structured raw output), and
  `ConsensusSessionWindow.vue` (synthesis + round contributions), so agent prose renders as
  formatted markdown consistent with `AgentStepDetail`'s reader.
- **UX-44 — Result-view polish. PARTIAL (copy affordances done).** Copy buttons
  (`common/CopyButton.vue`) now sit on the pretty-printed JSON block
  (`GenericStructuredResultView.vue`) and on the consensus synthesis + each round contribution
  (`ConsensusSessionWindow.vue`). **Still todo:** jump-to-latest in the live consensus stream,
  and timestamps on review findings/answers so a re-summoned user can tell what's new.

## D. Settings, keys & integrations

| ID    | Sev | Status | Finding                                                                                            |
| ----- | --- | ------ | -------------------------------------------------------------------------------------------------- |
| UX-45 | P1  | todo   | Direct provider API keys saved without any validation probe                                        |
| UX-46 | P2  | todo   | Connected keys show no last-4 / created-date identity hint                                         |
| UX-47 | P2  | todo   | Key-removal confirm is generic — doesn't name the key                                              |
| UX-48 | P2  | todo   | Datadog/incident connections: no Test button, no key-page links, no scopes stated                  |
| UX-49 | P2  | todo   | 428 password modal never explains the 40h client-side password caching                             |
| UX-50 | P2  | todo   | Model pickers are unsearchable dropdowns (catalog can be 300+ models)                              |
| UX-51 | P2  | todo   | Merge presets: % semantics not shown; no "used by" / default hint                                  |
| UX-52 | P2  | todo   | High-blast-radius disconnects (GitHub App) are one accidental Enter away                           |
| UX-53 | P2  | todo   | No unsaved-changes protection in settings panels (tab switch / Escape discards)                    |
| UX-54 | P3  | todo   | Manual GitHub installation-id field gives no hint where the id comes from                          |
| UX-55 | P3  | todo   | Vendor credential steps are plain text — no "create token" link                                    |
| UX-56 | P3  | todo   | Mixed save granularity inside WorkspaceSettingsPanel (one Save for 5 sections; Budget separate)    |
| UX-57 | P3  | todo   | Raw backend error text piped verbatim into toasts/status across settings                           |
| UX-58 | P3  | todo   | Local runner endpoints savable without a (re)successful test after URL edits                       |
| UX-59 | P3  | todo   | Slack member map requires hand-pasting raw `Uxxxx`/GitHub ids, no lookup                           |
| UX-60 | P3  | todo   | Password modal doesn't name the run/task it gates; expiry date field doesn't state its consequence |
| UX-61 | P3  | todo   | AI-onboarding modal: no explicit skip/later button; operator note nearly invisible                 |

- **UX-45 — Unvalidated keys.** `providers/ApiKeysSection.vue:179` +
  `stores/apiKeys.ts:38-43` — pasting a direct key POSTs and toasts "Connected"
  without a probe, so a typo'd/expired key looks configured and fails later at run
  dispatch, far from the cause. `OpenRouterCatalogPanel.vue:118-165` already
  implements probe-then-rollback; `UserSecretsSection`/`LocalModelEndpointsPanel`/
  `ProviderConnectionTab` have Test buttons. Fix: same probe-before-success path.
- **UX-46 — Anonymous keys.** `ApiKeysSection.vue:356-367` — a key row shows only
  the user label + usage; two keys for one provider are indistinguishable. Fix:
  last-4 suffix + created timestamp.
- **UX-47 — Generic delete confirm.** `ApiKeysSection.vue:212-213` passes the
  generic noun to `confirmAction('remove', …)`; `VendorCredentialsModal.vue:143-150`
  does it right (interpolates `cred.label`).
- **UX-48 — Blind Datadog save.** `ObservabilityConnectionPanel.vue:112-131`
  (+ incident block :256-269) — no Test, no link to the vendor's key page, no
  scopes stated; failures surface only when the post-release-health gate silently
  can't read monitors.
- **UX-49 — Undisclosed password cache.** `providers/PersonalCredentialModal.vue:110-121`
  vs `stores/personalSubscriptions.ts:31-32,117-127` — the password is cached in
  localStorage for ~40h, but the modal never says so, making the re-prompt cadence
  feel random and hiding a disclosure users should get. Fix: one line of copy
  (+ optionally a "don't remember" choice).
- **UX-50 — Unsearchable model pickers.** `settings/ModelConfigurationPanel.vue:168-176`
  (base) and `:179-194` (per-agent override) render the full `selectableModels`
  list with no filter — while the _agent-kind_ list right below has one (`:453`).
  With OpenRouter enabled the list can exceed 300 entries. Related: the OpenRouter
  browse list itself renders unvirtualized (`OpenRouterCatalogPanel.vue:75-81,346-348`)
  and janks on mount — cap, filter-first, or virtualize.
- **UX-51 — Opaque preset semantics.** `settings/MergeThresholdsPanel.vue:234-306`
  edits thresholds 0–100 with no `%` unit (stored 0–1, :88-90), and nothing shows
  which tasks use a preset or which is the workspace default.
- **UX-52 — One-click GitHub disconnect.** `github/GitHubPanel.vue:49-63` (also
  Slack :111-125, presets, keys) all use the simple accept/cancel
  `useConfirm`. For the App the whole board depends on, require typing the name.
- **UX-53 — Settings lose edits.** `WorkspaceSettingsPanel.vue` (draft :109-120),
  `MergeThresholdsPanel.vue` (drafts :46), `SlackPanel.vue` (:43-59) all hold local
  edits discarded on Escape/backdrop/tab-switch with no warning. (Same theme as
  UX-18/UX-33.)
- **UX-54..UX-61 — smaller settings polish.** Manual installation-id field
  (`github/GitHubConnect.vue:178-192`) needs a "where do I find this" link;
  `VendorCredentialsModal.vue:203-207` steps should link the vendor console;
  `WorkspaceSettingsPanel.vue:359-369` vs `:411-421` mixed save scopes;
  raw `e.message` in toasts across `ApiKeysSection.vue:205`, `SlackPanel.vue:63-70`,
  `ObservabilityConnectionPanel.vue:38-45`, `VendorCredentialsModal.vue:132-138`,
  `ProviderConnectionTab.vue:153,231`, `OpenRouterCatalogPanel.vue:344`;
  `LocalModelEndpointsPanel.vue:117-127` allows saving an endpoint whose URL
  changed since the last green probe; `SlackPanel.vue:292-311` member ids are
  hand-typed with placeholders only; `PersonalCredentialModal.vue:50-61` doesn't
  name the gated task and `PersonalSubscriptionSection.vue:253-255` doesn't state
  what expiry does; `AiProviderOnboardingModal.vue:103-105` buries the operator
  note at `text-[11px]` and offers no explicit skip.

## E. Async state, realtime & error surfacing

| ID    | Sev | Status | Finding                                                                                 |
| ----- | --- | ------ | --------------------------------------------------------------------------------------- |
| UX-70 | P1  | done   | Board whose WebSocket never connects is silently non-live — no indicator                |
| UX-71 | P2  | done   | Debounced board refresh swallows failures → silently stale board                        |
| UX-72 | P2  | done   | Reconnect declares "connected" even when the resync refresh failed                      |
| UX-73 | P2  | done   | Preview polling stops silently on transient error → stuck "Starting…" forever           |
| UX-74 | P2  | done   | Service-spec window error state has no retry                                            |
| UX-75 | P3  | done   | Observability panel error has no retry; context-load failure masquerades as empty state |
| UX-76 | P3  | done   | `removeDependency` has no error handling (sibling `toggleDependency` does)              |
| UX-77 | P3  | done   | Actionable error toasts auto-dismiss, taking their remedy button with them              |

- **UX-70 — Never-connected is invisible. DONE.** `useWorkspaceStream` now tracks the
  per-workspace connection lifecycle (`everConnected` + `connectionFailed`, reset on
  `start()`): after `INITIAL_FAIL_ATTEMPTS` (3) failed connects with no successful handshake it
  flags `connectionFailed`, and `ConnectionStatusBanner` renders a distinct rose "not receiving
  live updates" strip (`data-testid="stream-offline"`, `i-lucide-wifi-off`) — separate from the
  amber reconnecting strip (which only shows once we HAVE been live). The banner's local
  `everConnected` tracking moved into the stream (passed as props) so both variants read the same
  source of truth.
- **UX-71 — Swallowed coarse refresh. DONE.** `debouncedBoardRefresh` now routes through
  `refreshWithRetry(workspaceId)` (up to `REFRESH_MAX_ATTEMPTS`, backoff 0.4→4s), aborting between
  attempts if the stream stopped or the workspace switched — one transient failure no longer leaves
  the board silently stale.
- **UX-72 — Optimistic reconnect. DONE.** The on-`open` resync uses the same
  `refreshWithRetry` instead of `refresh().catch(() => {})`, so a reconnect whose first reconcile
  fails now retries rather than presenting as fully live while missing the outage's events.
  `connected` is still flipped even if every retry fails (we ARE connected; a refresh error must
  not wedge the indicator / the e2e `data-connected` gate).
- **UX-73 — Preview stuck forever. DONE.** `stores/preview.ts` `refresh` now, on a poll-tick
  error while the last known state is `starting`, keeps polling up to `POLL_MAX_ERRORS` (5) — so a
  transient blip self-heals — then surfaces the error into `requestError` and stops, instead of
  silently wedging the amber "Starting…" forever. A successful tick resets the per-frame error
  counter.
- **UX-74 — No retry on spec load. DONE.** `spec/ServiceSpecWindow.vue`'s error state gained a
  Retry button (`common.retry`, `:loading` bound to the store's loading flag) calling
  `serviceSpec.load(blockId)`.
- **UX-75 — Observability gaps. DONE.** `stores/observability.ts` now records
  `contextErrors[executionId]` on a `loadContext` failure (cleared on each attempt); the panel's
  context view shows a distinct error-with-retry state (`observability.contextError` + Retry)
  before the `noContext` empty state, so a fetch failure no longer masquerades as "no context
  stored". The calls view's existing error state also gained a Retry (`observability.load`).
- **UX-76 — Unhandled removeDependency. DONE.** `stores/board.ts` `removeDependency` is now
  wrapped in try/catch mirroring `toggleDependency`, toasting `board.toast.unlinkFailed` on
  failure instead of rejecting unhandled with no feedback.
- **UX-77 — Vanishing remedies. DONE.** The two action-bearing conflict toasts in
  `usePipelineErrorToast` (`providers_unconfigured` → "Configure AI",
  `binary_storage_unconfigured` → "Configure storage") now set `duration: 0` so the one-click
  remedy stays reachable instead of auto-dismissing (~5s). Non-actionable toasts keep the default.

## F. Accessibility, keyboard & theming

| ID    | Sev | Status | Finding                                                                                  |
| ----- | --- | ------ | ---------------------------------------------------------------------------------------- |
| UX-62 | P1  | todo   | Icon-only close/action buttons with no accessible name (widespread)                      |
| UX-63 | P2  | todo   | No single labeling convention for icon buttons (title-only vs aria-only vs both vs none) |
| UX-64 | P2  | todo   | Clickable non-interactive `<div>` steps on board cards — not keyboard-operable           |
| UX-65 | P2  | todo   | Color-only focus indicator on hand-rolled inputs (`outline-none` + border-hue swap)      |
| UX-66 | P2  | todo   | Animations ignore `prefers-reduced-motion` (infinite board pulses, marching ants)        |
| UX-67 | P2  | todo   | No light mode / system color-scheme support; palette hardcoded                           |
| UX-68 | P3  | todo   | Keyboard-shortcuts cheatsheet lists 4 shortcuts; others undocumented                     |
| UX-69 | P3  | todo   | Board nodes not in the tab order — no keyboard path to a specific card                   |

- **UX-62 — Unlabeled icon buttons.** Representative: `focus/BlockFocusView.vue:108`,
  `clarity/ClarityReviewWindow.vue:267`, `brainstorm/BrainstormWindow.vue:284`,
  `panels/InspectorPanel.vue:265`, `panels/AgentStepDetail.vue:291`,
  `panels/ObservabilityPanel.vue:200`, `settings/ModelConfigurationPanel.vue:289`,
  `pipeline/PipelineBuilder.vue:488` — `<UButton icon="i-lucide-x">` with neither
  `aria-label` nor `title`; the primary dismiss of most hand-rolled windows is
  unnamed to screen readers. The `common.close` i18n key already exists.
- **UX-63 — No convention.** `StepContainerStatus.vue:120-121` does both `:title`
  and `:aria-label` (correct); elsewhere title-only (`ArtifactLightbox`,
  `PipelineBuilder`), aria-only (`github/AddServiceFromRepoModal.vue:297`), or
  nothing. Fix: an `IconButton` wrapper (or lint rule) enforcing `aria-label`.
  Native `title` alone also never fires on touch — pair with `UTooltip`
  (`ArtifactLightbox.vue:182-275`, `PipelineBuilder.vue:470-494`).
- **UX-64 — Keyboard-dead click target.** `board/nodes/TaskPipelineMini.vue:82-86`
  — `<div class="cursor-pointer" @click.stop="openStep(i)">` with no role, tabindex,
  or key handler; the mini pipeline steps can't be opened by keyboard. Make it a
  `<button>`.
- **UX-65 — Invisible focus.** `humanTest/HumanTestWindow.vue:292`,
  `followUp/FollowUpWindow.vue:203`, `gates/GateResultView.vue:289`,
  `visualConfirm/VisualConfirmationWindow.vue:289,343` — raw inputs with
  `focus:outline-none focus:border-amber-500` (hue-only, same width) fail
  WCAG 2.4.7. Add `focus-visible:ring-2`.
- **UX-66 — Motion never reduced.** `assets/css/main.css:45-95` — `board-pulse`,
  `board-pulse-green`, marching-ants `board-dash` loop infinitely regardless of
  `prefers-reduced-motion`; only `spa-loading-template.html:126` honors it. Wrap
  keyframes in `@media (prefers-reduced-motion: no-preference)` or add a global
  reduce reset.
- **UX-67 — Dark-only.** Zero `dark:`/`useColorMode`/`prefers-color-scheme`
  matches; palette hardcoded to slate/`#0b1020` (`main.css:14-16`) with only a
  `--board-bg` variable. Light/high-contrast users have no option. At minimum,
  expose the palette as CSS variables to make theming possible.
- **UX-68 — Sparse cheatsheet.** `common/KeyboardShortcutsHelp.vue:23-28` lists
  ⌘K/Esc/Del/`?` only; the lightbox shortcuts and the intentional
  Delete-not-Backspace subtlety (`useKeyboardShortcuts.ts:70-79`) are undocumented.
- **UX-69 — Untabbable board.** Vue Flow nodes are pointer-first; there is no
  keyboard path to select/open a specific card (⌘K exists but doesn't cover
  spatial selection). Consider a roving tabindex or command-bar coverage, or
  document the command bar as the keyboard entry point. (Pairs with UX-12.)

---

## Verified good patterns (preserve these; copy them when fixing)

- Optimistic mutations in `stores/board.ts` snapshot and roll back with toasts;
  `updateBlock:363-372` even re-resolves so a mid-flight live event isn't clobbered.
- `components/board/AgentFailureCard.vue` — first-class retry with in-flight guard
  on every failed run/bootstrap.
- `composables/useFocusTrap.ts` — proper trap, focus-on-open, restore-on-close;
  `media/ArtifactLightbox.vue:157-171` is an exemplary dialog (role, aria-modal,
  dynamic label, Esc, alt text). `layout/SideBar.vue:134-145` uses `inert`.
- `layout/ConnectionStatusBanner.vue:59-64` — `role="status"` + `aria-live`.
- `panels/StepContainerStatus.vue:70` — the clipboard-with-toast pattern to reuse;
  `:120-121` — the title+aria-label icon-button pattern to reuse.
- Destructive task reset / PR merge are confirm-gated (`TaskExecution.vue:148-179`);
  step restart/reject use two-click inline confirms.
- Markdown in `AgentStepDetail.vue` parsed safely (`utils/agentOutput.ts`,
  `html:false`, links `target=_blank rel=noopener`); external links consistently
  `rel="noopener"`.
- Nearly every async submit disables + shows `:loading`; errors surface as toasts;
  no `window.alert/confirm/prompt` anywhere; a shared `ConfirmDialog` guards most
  destructive actions; subtask progress bars guard `total > 0` (no 0/0);
  inspector data is keyed by block id so quick switching doesn't show stale
  cross-block data; `pages/index.vue:371-378` has a proper backend-unreachable
  screen with Retry; date formatting is uniformly i18n `d()`.

## Suggested fix order

1. **P1 batch (flow-blocking / data loss):** UX-32 (hidden gate actions), UX-18 +
   UX-33 (discarded input), UX-01/02/03 (delete & reparent without undo), UX-70
   (silently non-live board), UX-45 (unvalidated keys), UX-62 (unnamed close buttons).
2. **Shared primitives:** dirty-modal seam, `IconButton` wrapper, clipboard+toast
   helper, secret-input-with-reveal component — these unlock whole clusters of P2s.
3. **P2 sweeps by section** (one PR per section above), then P3 polish
   opportunistically when touching the files anyway (per the i18n "lift copy when
   you touch a component" convention).

## Conventions & gotchas carried between iterations

- **Undo pattern = deferred destructive action, not client-only rollback.** A "real"
  undo can't just `reattach` the client cache after a successful server delete — a coarse
  `board` refresh (`useWorkspaceStream` → `workspace.refresh()`) would re-fetch the block
  (still present server-side) and resurrect it. The working pattern (see `board.ts`
  `removeBlock`): **defer** the backend mutation by `UNDO_WINDOW_MS`, hide the subtree
  optimistically, and keep it filtered out of `hydrate`/`upsert` via a `pendingDoomed` set
  until the window elapses; the undo toast action just cancels the timer + restores. Capture
  the workspace id at call time so the deferred call targets the right board after a switch.
  A reversible (non-destructive) action like reparent doesn't need deferral — just offer an
  "Undo" toast that performs the inverse move (mark the inverse non-undoable to avoid a
  ping-pong toast).
- The shared undo toast shape: `color: 'neutral'`, `duration: UNDO_WINDOW_MS`, a single
  `actions: [{ label: t('common.undo'), icon: 'i-lucide-undo-2', onClick }]`. Reuse it for
  the remaining undo items (UX-52 high-blast-radius disconnects).
- **Clipboard copies go through `useCopyToClipboard()` (never `navigator.clipboard` raw).**
  The composable (`composables/useCopyToClipboard.ts`) wraps VueUse's `useClipboard` and always
  toasts the outcome, only claiming success once the write landed — so an insecure context /
  denied permission surfaces as a failure toast instead of a silent no-op. For a plain
  copy-icon affordance use the shared `common/CopyButton.vue` (it carries both `title` and
  `aria-label`); for a copy folded into a bespoke button, destructure `{ copy }` from the
  composable. Default label is `common.copy`, so no new i18n keys are needed for a generic
  copy button.
- **Agent prose renders through `MarkdownProse` (never raw `whitespace-pre-wrap`).** For any
  result-view surface that shows an agent's prose output (a rationale, a synthesis, a summary),
  use the shared `common/MarkdownProse.vue` (backed by `renderMarkdown()` in
  `utils/agentOutput.ts` — secure markdown-it, `html:false`, links opened safely), not a
  plain-text `<pre>`/`<p whitespace-pre-wrap>`. It's the inline counterpart to the full
  segmented reader (`parseOutputOutline`) used by `AgentStepDetail`. Pair copy-able output
  (JSON, prose) with the shared `common/CopyButton.vue`.
- **Flush unsaved draft input on the close path via `useResultView`'s `onClose` hook**
  (not per-close-button handlers). A result-view window that holds editable draft state
  (the review windows) passes `onClose: () => void flushDrafts()`; the composable fires it
  on the X button, the backdrop click, AND the Escape key, so no close path can leak. The
  flush MUST snapshot whatever it needs (the review, the block id) synchronously up front —
  the reactive `blockId`/derived state go null the moment `closeResultView()` runs, so an
  async persist that re-reads them mid-flight silently no-ops.
- **A best-effort async load that can fail must NOT swallow the error into an empty/idle state.**
  A store's `catch {}` that sets nothing renders as "nothing here" — indistinguishable from
  genuine emptiness (the `loadContext` → `noContext` trap, UX-75). Record a per-key error message
  (`contextErrors`/`requestError`/`errors` shaped `Record<id, string | null>`), render a distinct
  error state, and offer a Retry that re-invokes the same loader (reuse `common.retry` — no new
  key). For a poll loop, a transient tick failure should keep polling up to a small cap (self-heal)
  then surface the error and stop — never wedge a spinner forever (UX-73).
- **Realtime resync/refresh retries; it does not fire-and-forget.** A coarse `workspace.refresh()`
  driven by a `board` event or a socket (re)connect goes through a bounded retry-with-backoff
  helper (`refreshWithRetry` in `useWorkspaceStream`) that aborts if the stream stopped or the
  workspace switched — one transient failure must not leave the board silently stale. `connected`
  is still announced even if every retry fails (we ARE connected; the resync is a best-effort
  reconcile, and wedging the indicator would break the e2e `data-connected` gate).
- **Action-bearing error toasts are sticky (`duration: 0`).** A toast whose value is a one-click
  remedy button ("Configure AI") must not auto-dismiss and take the remedy with it. Plain
  informational error toasts keep the default duration.
- When fixing i18n papercuts (UX-13), remember the locale-parity CI check: adding,
  changing, OR removing an `en.json` key requires the same change in every other locale in
  the same PR (removing the two dead `clarity.*` keys above meant editing all 8 locales).
- Frontend fixes to `@cat-factory/app` need a changeset (patch), and any new
  interactive affordance covered by e2e wants a `data-testid`.
- Line references are from the 2026-07-02 audit; re-verify anchors before editing.
- Findings marked as corroborated by two independent audit passes: UX-13, UX-25,
  UX-19/20 (secrets), UX-01 (delete/undo).
