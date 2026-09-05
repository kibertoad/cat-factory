# UX papercuts & improvements: audit + fix tracker

Status: **fixes in progress.** Slices landed: the undo & confirmation-blast-radius
cluster (UX-01/02/03/13, [#737](https://github.com/kibertoad/cat-factory/pull/737)); the
clipboard-feedback shared primitive (UX-38/39); friendly model/agent-kind labels in the
review & consensus windows (UX-36/37); markdown prose + copy affordances in the result
views (UX-43, UX-44 copy buttons); the review-window gate-actions + draft-persistence
cluster (UX-32/33/34); the async-state / realtime / error-surfacing section E in full
(UX-70..UX-77; offline indicator, retrying refresh/resync, self-healing preview poll,
retry affordances, sticky remedy toasts); the accessibility icon-labeling / keyboard /
focus / reduced-motion cluster (UX-62..66; the `IconButton` primitive, keyboard-operable
mini-steps, focus-visible rings, reduced-motion guards); the secret-input reveal cluster
(UX-19/20; the `SecretInput` primitive: every password field and every plaintext secret
textarea now masks by default with an eye toggle); the board zoom/canvas navigation cluster
(UX-07/08/09/14/15/16; labeled+clamp-disabled zoom controls, a click-to-reset-100% readout,
double-click-to-focus a frame, and a nudge on blank-canvas pipeline drops); the
modal-safety cluster (UX-18/25; the `useUnsavedGuard` confirm-before-discard seam on the
content-heavy modals + DecisionModal double-submit protection); the pipeline/inspector
surfaces cluster (UX-35/40/41/42; live per-step elapsed clocks, a named reason on the locked
Run trigger, a confirm before stopping a run, and a keyboard-reachable restart button); the
fragment/Slack form-integrity cluster (UX-21/23/29/30; confirm before unlinking a fragment
source, per-row loading spinners, stable+validated Slack member-map rows, a pending Slack OAuth
button); and border-anchored frame resizing (UX-17, [#1537](https://github.com/kibertoad/cat-factory/pull/1537); grips moved onto the frame's own border
with a cursor held for the drag). This document catalogs UX papercuts
(small annoyances, missing affordances, rough edges) found in the SPA
(`frontend/app/app`) during a systematic sweep on 2026-07-02. Every finding was
verified against the code at the referenced `file:line` (line numbers drift as the
tree moves: treat them as anchors, not gospel).

**Re-audited 2026-08-18.** Every then-open item was re-verified against HEAD and the
statuses below updated in place: UX-57 is closed by the error-toast funnel work,
UX-27/49/51/60 re-graded partial, and UX-51's surface is now the risk-policy library.
A second systematic sweep covered the ~190 components added since the first audit
(the tutorial system, initiative planning/tracker, PR review, the environment wizard,
foundational services, binary candidates, and the new settings panels): its findings
are sections G-K (UX-78..UX-111), verified the same way; anchors there are from
2026-08-18.

**2026-08-18, highest-impact P1 slice.** UX-78, UX-79, UX-80, UX-82, UX-93 and UX-94
landed together: the double-submit that filed two tasks and started two pipeline runs,
the draft loss across every result window (fourteen of them, not the four UX-79 named),
the keyboard-uncompletable binary-candidates gate and its blank body, the silent persist
failures on the two interview windows, the unconfirmed irreversible pipeline delete, and
the index-keyed secret rows that could save one secret's value under another's key. Each
item's entry below records what shipped.

Reviewing that slice found a second round of the same defects one layer down, all of
which shipped with it: the shared confirm dialog could not be cancelled by Escape from
inside a result window (and, once dismissed, stayed on screen resolving nothing), two
guard snapshots reported drafts their own submit button could never send while a third
missed two forms entirely, the candidate flush abandoned every answer after the first
failed write, and a second Delete click silently cancelled the confirm already open.
The lesson each of those carries is in the conventions section at the end.

## Goal & rationale

The product's core flows (board, pipelines, review gates, integrations) are
functionally solid, but a layer of small UX debt accumulates friction: destructive
actions without undo, silently lost input, unlabeled controls, silent failures.
Each item is individually cheap; together they define the difference between
"works" and "feels good". The intent is to burn these down incrementally
(a handful per PR, grouped by area) using the checklist below as the durable
source of truth across iterations.

**How to use this doc:** pick a cluster of `todo` items (ideally one section, or one
cross-cutting theme), fix them in one PR, flip their status to `done` with a PR
link, and carry any new conventions into the _Conventions_ section at the bottom.

## Severity legend

- **P1**: actively loses user data/work, blocks a flow, or hides a required action.
- **P2**: misleads the user, forces workarounds, or is a systemic inconsistency.
- **P3**: polish; low individual impact but compounding.

## Cross-cutting themes

These recur across many components; fixing them wants a shared primitive, not
per-file patches:

1. **No undo, and confirmations that undersell blast radius** (UX-01, UX-02, UX-03,
   UX-52). The rollback snapshot machinery already exists in `stores/board.ts`:
   undo is one toast-action away.
2. **Typed input silently discarded** on Escape/backdrop-close of modals and review
   windows, and on settings tab switches (UX-18, UX-33, UX-58). Wants a shared
   dirty-check + confirm-before-discard seam on the modal primitive.
3. **Secrets UX is inconsistent**: some fields are masked, some are plaintext
   textareas, none have a reveal toggle, keys are saved unvalidated and displayed
   without identity hints (UX-19, UX-20, UX-45, UX-46, UX-47).
4. **Icon-only buttons without accessible names / tooltips**, no single convention;
   coverage is accidental (UX-62, UX-63). Wants an `IconButton` wrapper or a lint rule.
5. **Clipboard actions without feedback** and error surfaces without copy buttons
   (UX-38, UX-39). One good pattern exists (`StepContainerStatus.vue`): reuse it.
6. **Silent async failure paths**: swallowed refreshes, polling that stops forever,
   error states with no retry (UX-70..UX-76).
7. **Raw internal identifiers leaking into UI**: model ids, agent-kind enums,
   backend error prose (UX-36, UX-37, UX-57).
8. **(2026-08-18) Primitive adoption stalls at the primitive.** Every shared seam the
   first audit produced exists and works (`IconButton`, `SecretInput`, `CopyButton`,
   `MarkdownProse`, `useConfirm`/`useConfirmAction`, `useUnsavedGuard`,
   `useResultView.onClose`, per-row in-flight sets, the error-with-Retry store shape),
   and the surfaces built after them mostly bypass them (sections G-K). The durable
   fix is an adoption sweep plus an enforcement hook (a lint rule or a review
   checklist entry per primitive), not another primitive.

---

## A. Board & canvas

| ID    | Sev | Status       | Finding                                                                        |
| ----- | --- | ------------ | ------------------------------------------------------------------------------ |
| UX-01 | P1  | done (#737)  | No undo after a successful block delete                                        |
| UX-02 | P1  | done (#737)  | Delete confirmation never states cascade scope                                 |
| UX-03 | P1  | done (#737)  | Accidental drag-reparent commits silently, no undo                             |
| UX-04 | P2  | todo         | Drag/reparent has no drop-target highlighting                                  |
| UX-05 | P2  | todo         | Dependency drag-to-connect: no target highlight, silent no-op on invalid drop  |
| UX-06 | P2  | todo         | Dependency edges cannot be removed (or hovered) on the canvas                  |
| UX-07 | P2  | done (#847)  | Pipeline dropped on blank canvas gives no feedback                             |
| UX-08 | P2  | done (#847)  | Zoom / fit-view toolbar buttons lack tooltips; `maximize` glyph ambiguous      |
| UX-09 | P2  | done (#847)  | Double-clicking a frame/epic is a dead no-op                                   |
| UX-10 | P2  | todo         | Selection, zoom, viewport lost on reload / workspace switch                    |
| UX-11 | P2  | todo         | Camera doesn't refit on workspace switch                                       |
| UX-12 | P2  | todo         | No arrow-key navigation or keyboard block movement                             |
| UX-13 | P2  | done (#737)  | Hardcoded English toast `'Could not move'` in `moveBlock`                      |
| UX-14 | P3  | done (#847)  | No reset-zoom-to-100%; zoom readout not clickable                              |
| UX-15 | P3  | done (#847)  | Zoom/LOD readout hidden below `sm` breakpoint                                  |
| UX-16 | P3  | done (#847)  | Zoom buttons don't disable at min/max                                          |
| UX-17 | P2  | done (#1537) | Frame-resize grips sit inside the frame and read as scrollbars, 8px hit target |

- **UX-01, No undo after delete. DONE.** `stores/board.ts` `removeBlock` now
  **defers** the backend delete by a `UNDO_WINDOW_MS` (6s) window and shows a
  "Deleted X (Undo" toast whose action cancels the pending call and `reattach`es the
  subtree) a genuine undo, since nothing was destroyed server-side yet. The pending
  subtree is filtered out of every `hydrate`/`upsert` (`applyPendingRemovals` +
  `pendingDoomed`) so a coarse refresh or stray live event can't resurrect it, and the
  deferred call captures the workspace id so a mid-window switch still deletes the right
  board. (The recurring-pipeline delete path keeps its immediate-delete semantics.)
- **UX-02: Cascade scope not stated. DONE.** `useBlockDeletion.copyFor` now reads a
  pure `board.descendantsOf(id)` count (added to `useBlockQueries`) and, for a non-empty
  container, uses the pluralized `confirmDelete.containerBodyWithCount` so the confirm
  states the exact number of items that go with it.
- **UX-03: Silent drag-reparent. DONE.** A successful `reparentBlock` into a
  _different_ container now offers the same "Moved X: Undo" toast, moving the block back
  to its previous parent + position (the undo move is itself non-undoable so the toast
  doesn't ping-pong). Covers the drag-overshoot-into-a-neighbour case.
- **UX-04, No drop-target highlight.** `useBlockDrag.ts:69-92`,
  `components/board/BoardCanvas.vue:113-116`. Destination resolved via
  `elementFromPoint` _on release only_; nothing highlights the hovered drop zone
  during the drag. Fix: a `hoveredDropZoneId` ref driving a ring (mirror the
  `useFrameStacking` hover pattern).
- **UX-05: Dependency connect is blind.** `composables/useDependencyConnect.ts:33-49`.
  No candidate-card highlight while dragging; release over a non-task / same task
  silently `return`s. Fix: highlight hovered task, toast on invalid drop.
- **UX-06: Edges not removable on canvas.**
  `components/board/TaskDependencyEdges.vue:163`: the whole SVG overlay is
  `pointer-events-none`. Removal requires re-running the exact same drag
  (`toggleDependency`), which is undiscoverable. Fix: clickable edge with hover "×".
- **UX-07: Silent failed pipeline drop. RETIRED.** Fixed at the time (`BoardCanvas.vue`'s
  `onDrop` raised a "drop onto a task" nudge instead of returning silently), then removed
  with the draggable block/pipeline palettes: nothing produces a palette drop payload any
  more, so the canvas no longer carries a drop handler at all.
- **UX-08: Untitled zoom controls. DONE.** The three zoom controls in
  `BoardToolbar.vue` now route through the shared `common/IconButton.vue` primitive with
  labels (`board.toolbar.zoomOut`/`zoomIn`/`fitView`), applied as both `:title` and
  `:aria-label`, so `i-lucide-maximize` (fit-to-content) is no longer an ambiguous
  "fullscreen" glyph.
- **UX-09: Dead double-click. DONE.** `BoardCanvas.vue`'s `onNodeDoubleClick` no longer
  calls the inert `ui.toggleFrame` (frames are always expanded, so it gated nothing).
  Because a task card lives _inside_ its frame's Vue Flow node, the handler resolves the
  real double-click target from the DOM (`blockIdFromEvent`): a task double-click opens
  that task's focus view (`ui.focus`, the same gesture the card's review action uses),
  while a double-click on frame chrome `focusFrame`s the frame; centres the camera and
  zooms in, a quick "focus this service" gesture. Epics (non-containers) stay a no-op.
- **UX-10: Transient view state.** `selectedBlockId` and `zoom` are plain refs
  (the store split; they now live in `stores/ui/navigation.ts:16-20`);
  `BoardCanvas.vue:229-232` only does `fit-view-on-init`. Fix: persist
  per-workspace (localStorage). The `expandedFrames` clause is obsolete: frames
  are always expanded and that set was deleted.
- **UX-11, No refit on workspace switch.** `BoardCanvas.vue:181`. Switching
  workspaces swaps frames without re-fitting; user can land on empty canvas and
  think the workspace is blank. Fix: `fitView()` on workspace change.
- **UX-12, No keyboard spatial actions.** `composables/useKeyboardShortcuts.ts:50-80`
  implements only Escape / Delete / `?`. No arrow-key traversal or nudge; every
  spatial action requires a pointer. (See also UX-69.)
- **UX-13: Un-i18n'd move-failure toast. DONE.** `moveBlock`'s failure toast now uses
  `tr('board.toast.moveFailed')` (the key already existed) instead of the literal
  `'Could not move'`.
- **UX-14/15/16: Zoom polish. DONE.** The `%`/LOD readout in `BoardToolbar.vue` is now a
  real `<button>` (`board-zoom-reset`) that snaps the camera back to 100% via
  `useBoardFlow().resetZoom()` (`zoomTo(1)`), titled `board.toolbar.resetZoom` with a
  focus-visible ring (UX-14); it's always visible now (only the LOD sub-label drops below
  `sm`) so the zoom level is never a mystery (UX-15); and the zoom-in/out `IconButton`s
  `:disabled` at the clamps via `atMinZoom`/`atMaxZoom` computed against the shared
  `BOARD_MIN_ZOOM`/`BOARD_MAX_ZOOM` constants (now sourced from `useBoardFlow.ts` and
  consumed by `<VueFlow>` too, so the clamps can't drift from the button-disable logic)
  (UX-16).
- **UX-17: Grips in the wrong place, too small, and only on two borders. DONE.** Re-graded to
  P2: the audit caught the 8px hit target but missed the bigger half, which a user reported as
  "resizing is done by dragging scrollbars inside the frame". On a service frame the grips were
  children of the inner drop zone, so both 8px strips sat 16px INSIDE the visible border, flush
  against the task canvas: geometry that reads as a pair of scrollbars, not as the frame's edge,
  so the gesture had to be discovered rather than guessed.

  All eight borders/corners are now grips on the box itself (`board/nodes/ResizeGrips.vue`, shared
  by the service frame and the module so the two can't drift), each STRADDLING the border it moves:
  a 12px hit band centred on the edge, 24px on a coarse pointer, with the drawn affordance still a
  2px bar lit ON the border. One predicate drives that highlight for both the resting pointer and
  the drag, reading the GRABBED border while resizing rather than the hovered one: the pointer
  routinely leaves a 12px band mid-drag, and the border being moved has to stay lit.

  **Dragging the north/west border moves the container's content ORIGIN, and a child's position is
  stored relative to that origin**, so the contents would otherwise slide with the border instead
  of the border extending past them. `POST /blocks/:id/resize` carries both halves of the geometry
  and translates the direct children by the inverse delta in ONE arithmetic UPDATE
  (`BlockRepository.shiftChildPositions`, mirrored D1 ⇄ Drizzle with conformance assertions both
  ways); the store applies the same compensation optimistically during the drag and replays it
  inverted on a rejected write. Grandchildren need no pass of their own: a task inside a module
  rides the module. Shrinking from those borders is floored by the NEAREST child, not just the far
  edge (`contentSize` measures only the far edge, which moves inward in step with the border, so
  nothing there ever objects).

  `useFrameResize` also holds the edge's cursor on `<body>` for the whole drag, so the pointer
  outrunning the band no longer reads as a dropped grab, and restores it on `pointercancel` as well
  as `pointerup` so an interrupted touch can't leave the cursor stuck. The grips are `v-if`'d on
  `board.write`, which is what the composable's comment already claimed but only `startResize`
  enforced.

## B. Modals, forms & inputs

| ID    | Sev | Status  | Finding                                                                            |
| ----- | --- | ------- | ---------------------------------------------------------------------------------- |
| UX-18 | P1  | done    | Content-heavy modals discard all typed input on Escape/backdrop click              |
| UX-19 | P2  | done    | No show/hide toggle on any password/secret field (systemic)                        |
| UX-20 | P2  | done    | Provider API key entered in a plaintext, unmasked textarea (several surfaces)      |
| UX-21 | P2  | done    | `unlinkSource` (fragment library) destroys a synced source with no confirmation    |
| UX-22 | P2  | todo    | Reset-password validation is submit-only, no inline feedback                       |
| UX-23 | P2  | done    | Slack member-mapping rows keyed by index; incomplete rows silently dropped on save |
| UX-24 | P2  | todo    | Datadog connection can't be updated without re-pasting both write-only keys        |
| UX-25 | P2  | done    | DecisionModal options: fire-and-forget, no pending state, double-click hazard      |
| UX-26 | P3  | todo    | No autofocus on first field of login/reset/connect modals                          |
| UX-27 | P3  | partial | Disabled submit buttons don't state why (min-length rules invisible)               |
| UX-28 | P3  | todo    | No character counters where the backend enforces length limits                     |
| UX-29 | P3  | done    | Fragment library: one global loading flag spins every row's buttons                |
| UX-30 | P3  | done    | Slack "Add to Slack" OAuth button has no pending state                             |
| UX-31 | P3  | todo    | "Edit" on list items doesn't scroll/focus the offscreen edit form                  |

- **UX-18: Dirty modals discard input. DONE.** A shared `composables/useUnsavedGuard.ts`
  seam routes a controlled `UModal`'s dismiss paths (Escape, backdrop, Cancel) through a
  dirty check: it snapshots the form's user-owned state each time the modal opens and, on a
  close request, only prompts (`common.discard.*` confirm) when the current snapshot diverges;
  an unchanged form, or a submit in flight, closes immediately as before. The modal's
  `open` setter calls `requestClose()` instead of the store close, and the Cancel button does
  too. Wired into `AddTaskModal.vue`, `RecurringPipelineModal.vue`, and `BootstrapModal.vue`
  (the three that wiped title/description/per-type fields/attached context on an accidental
  Escape/backdrop). The `snapshot()` deliberately excludes async-resolved fields (AddTask's
  issue bodies are compared by stable context key, not the mutated body) and cheap toggles.
  The settings-panel variant (UX-53) can reuse the same seam. (Review-window variant: UX-33
  is done via `useResultView`'s `onClose`.)
- **UX-19, No reveal toggle. DONE.** A shared `common/SecretInput.vue` primitive (mirroring
  `IconButton`/`CopyButton`) wraps `UInput` with a masked default (`type="password"`) and a
  trailing eye-toggle button (labeled + `aria-pressed` via the new `common.reveal`/`common.hide`
  keys) so a user can verify a pasted token: the leading cause of invalid-credential retries.
  Every bare `type="password"` field now routes through it: both auth screens
  (`LoginScreen`, `ResetPasswordScreen`), the descriptor-driven `DocumentSourceConnectModal` +
  `UserSecretsSection` (via a `:secret` prop that preserves the `field.secret`-conditional
  masking), `ObservabilityConnectionPanel` (Datadog + PagerDuty + incident.io),
  `LocalModelEndpointsPanel`, `SlackPanel`, `PersonalCredentialModal`, and the
  audit-missed surfaces `AccountDeploymentSettings` (Slack/Linear/web-search/content-storage),
  `AccountTeamSettings` (email key), `KubernetesEnvironmentForm`/`KubernetesEngineForm`,
  `ProviderManifestEditor`, `PackageRegistriesPanel`. When `secret` is false it degrades to a
  plain text input with no toggle.
- **UX-20: Plaintext secret textareas. DONE.** The four fully-visible secret `UTextarea`s
  (`ApiKeysSection`, `VendorCredentialsModal`, `OpenRouterCatalogPanel`,
  `PersonalSubscriptionSection`) are converted to the same masked-by-default `SecretInput`, so
  live vendor keys no longer render in cleartext (shoulder-surf / screen-share leakage). These
  keys are single-line tokens, so the single-line masked input + reveal is the correct shape.
- **UX-21: Unguarded unlink. DONE.** `unlinkSource` in `FragmentLibraryManager.vue`
  now routes through `useConfirm()` (destructive variant, naming the `owner/repo` and
  new `fragments.confirmUnlinkSource.*` keys) before removing the source + its synced
  guideline fragments, mirroring the sibling `removeFragment` confirm.
- **UX-22: Submit-only validation.** `auth/ResetPasswordScreen.vue:21-30`: the
  length≥8 and match checks run only on submit; no live hint or match indicator.
- **UX-23: Fragile Slack mapping rows. DONE.** `SlackPanel.vue`'s member-map rows now
  carry a client-only stable `uid` (`v-model` keyed by `entry.uid`, not the array index)
  so deleting a middle row can't rebind a neighbour's inputs, and `saveMapping` **blocks**
  with a warning toast (`slack.members.incomplete{Title,Body}`) when any row is half-filled
  (exactly one of user-id / Slack-id present) instead of silently dropping it; a fully-empty
  row is still just an unused slot and is ignored.
- **UX-24: Datadog forced re-entry.** `settings/ObservabilityConnectionPanel.vue:216-219`
  disables save unless both write-only keys are present, so changing only `site`
  requires re-pasting both secrets, while the panel's own incident section (:75)
  supports "blank = keep existing". Fix: same blank-keeps semantics.
- **UX-25: DecisionModal double-submit. DONE.** `panels/DecisionModal.vue` `choose()` now
  tracks a `resolvingOption` ref: it awaits `execution.resolveDecision`, ignores a re-click
  while one is in flight, disables every option (spinner on the chosen one) until it settles,
  and on failure keeps the modal open with a `panels.decision.resolveFailed` error toast
  instead of closing silently. A fast double-click can no longer dispatch two resolutions.
  The modal's own dismiss affordances (Escape / backdrop) are locked while a resolve is in
  flight too, so the "in-flight" story is complete rather than only covering the buttons.
  (Independently flagged by two audit passes.)
- **UX-26: Missing autofocus.** `LoginScreen.vue:314`, `ResetPasswordScreen.vue:79`,
  `DocumentSourceConnectModal`, `DocumentImportModal`, `BootstrapModal` first
  inputs. Good counter-examples: `AddTaskModal:472`, `RecurringPipelineModal:147`.
- **UX-27: Unexplained disabled buttons. PARTIAL.** `PersonalSubscriptionSection.vue`
  now derives a single `disabledReason` computed (`:123-133`) bound to both
  `:disabled` and a visible line beside the button, so state and reason can't
  disagree (the UX-40 shape; copy it for the rest). Still open:
  `PersonalCredentialModal.vue:141` (`password.length < 6` with no helper text)
  and `ResetPasswordScreen` (the >=8 rule invisible until submit; see UX-22).
- **UX-28, No counters on bounded fields.** `bootstrap/BootstrapModal.vue:90-97`
  errors on repo-name >100 chars but the input has no `maxlength`/counter;
  description/instructions have neither.
- **UX-29: Global loading flag. DONE.** `FragmentLibraryManager.vue` no longer binds
  its row buttons to the shared `library.loading`. A `reactive(new Set())` of keyed
  in-flight ids (`refresh:`/`remove:`/`sync:`/`check:`/`unlink:` + row id) drives each row
  button's `:loading` via a `withRow(key, fn)` wrapper, so only the button that triggered an
  action spins (and `checkSource`/`unlinkSource`, previously unspinnable, now show progress).
  The three add/link submit buttons got their own local `creating`/`linkingDoc`/`linkingSource`
  refs so they no longer cross-spin during a row action (and the `linkSource` button, which
  never set `library.loading`, now shows its own progress).
- **UX-30: Inert OAuth button. DONE.** `SlackPanel.vue`'s "Add to Slack" button binds a
  `connectingOAuth` ref set before awaiting `installUrl()`; it clears only on the error path
  (the success path navigates the browser away), matching the paste-token button beside it.
- **UX-31: Edit without focus move.** `LocalModelEndpointsPanel.vue:228`,
  `UserSecretsSection`: "edit" mutates state but the form is below a long list;
  on small viewports the click appears to do nothing. Fix: scroll-into-view + focus.

## C. Review windows, inspector & pipeline surfaces

| ID    | Sev | Status  | Finding                                                                                                          |
| ----- | --- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| UX-32 | P1  | done    | Requirements/Clarity review actions completely hidden below `lg`: gate unadvanceable                             |
| UX-33 | P1  | done    | Typed review answers lost when window closes without blur/save                                                   |
| UX-34 | P2  | done    | Requirements auto-saves on blur; Clarity needs explicit "Save answer": opposite models                           |
| UX-35 | P2  | done    | No elapsed time on running steps in PipelineProgress / TaskExecution                                             |
| UX-36 | P2  | done    | Raw model id rendered verbatim in review windows                                                                 |
| UX-37 | P2  | done    | Internal `agentKind` enum + raw model id leak in consensus window                                                |
| UX-38 | P2  | done    | Clipboard copies give no feedback and swallow failures                                                           |
| UX-39 | P2  | done    | Agent/provider errors have no copy button                                                                        |
| UX-40 | P2  | done    | Inspector "Run" disabled with no explanation                                                                     |
| UX-41 | P2  | done    | Stopping a running bootstrap has no confirmation                                                                 |
| UX-42 | P3  | done    | "Restart from here" only visible on hover (invisible on touch)                                                   |
| UX-43 | P3  | done    | Agent prose rendered as plain text in several result views                                                       |
| UX-44 | P3  | partial | Structured JSON / consensus output lack copy buttons; no jump-to-latest in live stream; findings lack timestamps |

- **UX-32: Hidden gate actions. DONE.** The action rail in both
  `RequirementsReviewWindow.vue` and `ClarityReviewWindow.vue` was `<aside class="hidden
w-72 … lg:flex">`, so below `lg` (laptop split-screen, tablet) the human could answer
  findings but had no visible way to advance the gate. The `aside` is now a responsive
  rail: a right-hand column on wide screens (`lg:w-72 lg:border-s`) and a full-width
  bottom action bar below `lg` (`flex w-full border-t`, never hidden). The
  purely-informational stats block is the only thing hidden below `lg`
  (`hidden … lg:block`) so the mobile action bar stays compact; every action button shows
  at all sizes. (The `exceeded` state's `IterationCapPrompt` was already in the main
  column, so it was reachable: the fix is for the `ready`/`merged` actions +
  request-recommendations.)
- **UX-33: Lost review drafts. DONE.** `useResultView` gained an `onClose` hook that
  runs on EVERY close path (X, backdrop, Escape) before the view tears down; both review
  windows pass `onClose: () => void flushDrafts()`. `flushDrafts` now snapshots the review
  up front and threads it through `persistDraft`, so the persist completes even though the
  reactive `review`/`blockId` go null the instant the view closes.
- **UX-34: Inconsistent save models. DONE.** The clarity window was converted to
  auto-save-on-blur (the requirements pattern): a seeding `watch` pre-fills each textarea
  from the recorded reply, `persistDraft` saves on `@blur` only when the trimmed draft
  differs, and the explicit "Save answer" button (+ its `clarity.saveAnswer` /
  `clarity.refineAnswerPlaceholder` i18n keys, removed from all 8 locales) is gone. Both
  windows now behave identically.
- **UX-35, No elapsed clock. DONE.** `pipeline/PipelineProgress.vue` and
  `panels/inspector/TaskExecution.vue` now surface each step's elapsed time inline (a small
  mono clock next to the step's sub-label / state), so a running step that hasn't emitted
  subtasks reads as progressing rather than hung. `composables/useStepTimer.ts`'s
  freeze-at-finish/failure/park logic was extracted into pure helpers
  (`stepDurationMs`/`stepDurationLabel`/`stepIsRunning`) plus a shared `useNowTick()` 1s tick,
  so the list views drive N steps' live clocks from one interval and reuse the exact freeze
  rules the step-detail overlay already used. A finished step shows its total duration; a live
  one counts up.
- **UX-36: Raw model ref. DONE.** `RequirementsReviewWindow.vue` and
  `ClarityReviewWindow.vue` now render the reviewer model via
  `models.labelForRef(review.model) ?? review.model` (the friendly `<label> · <provider>`
  string the pipeline surfaces use: `StepMetadataCard`/`StepRunMeta`), falling back to the
  bare ref when the catalog hasn't loaded.
- **UX-37: Consensus leaks internals. DONE.** `consensus/ConsensusSessionWindow.vue` renders
  the session subtitle via `agentKindMeta(session.agentKind).label` and each participant's
  model via `models.labelForRef(p.modelId) ?? p.modelId` instead of the raw enum / raw
  `modelId`.
- **UX-38: Silent clipboard. DONE.** `StepContainerStatus.vue`'s copy-with-toast pattern
  is extracted into the shared `useCopyToClipboard()` composable (VueUse `useClipboard` +
  a success/failure toast; it only claims success once the write actually landed). Every
  silent site now routes through it: `StepMetadataCard.vue`/`StepRunMeta.vue` (`copyRunId`),
  `AgentStepDetail.vue` (`copyOutput`), `KubernetesEngineForm.vue` (auto-setup command), and
  `StepContainerStatus.vue` itself is refactored onto the composable so the duplication is gone.
- **UX-39: Uncopyable errors. DONE.** A reusable `common/CopyButton.vue` (title + aria-label,
  routed through `useCopyToClipboard`) puts a copy affordance on the failure surfaces: the
  `FailureDetail.vue` stack-trace `<pre>` (so both `AgentFailureCard` and `AgentFailureHistory`
  get it), the consensus failure banner (`ConsensusSessionWindow.vue`, when there's an error
  string), and the gate failure summary (`GateResultView.vue`, both the human-review and
  conflicts blocks).
- **UX-40: Unexplained lock. DONE.** `panels/InspectorPanel.vue`: a disabled task Run
  button now names WHY it is locked: `board.unmetDeps(id)` feeds a pluralized
  `panels.inspector.runBlocked` reason (the unfinished dependency titles), rendered both as
  the button `:title` AND as a visible amber hint line above the actions
  (`data-testid="run-blocked-reason"`). The visible line is deliberate: a native `title` on a
  disabled button never fires hover, so pointer, keyboard, and touch users all get the reason.
  (`isRunnable` is purely dependency-gated, so the reason is non-null exactly when the button
  is disabled.)
- **UX-41: Unguarded bootstrap stop. DONE.** The shared `board/AgentStopButton.vue` (used by
  the board card AND the inspector's bootstrap-stop) now routes through `useConfirm()` before
  killing the container (`board.stop.confirm.{title,body,confirm}`) matching the
  confirm-then-mutate contract the task reset path uses. Fixing it in the shared primitive
  covers every stop surface at once (bootstrap + execution runs alike).
- **UX-42: Hover-only restart. DONE.** The restart-from-here button in `PipelineProgress.vue`
  keeps its `opacity-0 group-hover:opacity-100` reveal but now also shows on
  `group-focus-within:opacity-100` (keyboard-tabbing into the step row reveals it) and
  `focus-visible:opacity-100` (the button itself receiving focus), so it is no longer invisible
  to keyboard/touch.
- **UX-43: Markdown as plain text. DONE.** A new shared `renderMarkdown()`
  (`utils/agentOutput.ts`: the same secure markdown-it config as the reader, `html:false`,
  links decorated to open safely) plus a reusable `common/MarkdownProse.vue` component replace
  the `whitespace-pre-wrap` dumps in `GenericStructuredResultView.vue` (prose summary),
  `MergerResultView.vue` (rationale + pre-structured raw output), and
  `ConsensusSessionWindow.vue` (synthesis + round contributions), so agent prose renders as
  formatted markdown consistent with `AgentStepDetail`'s reader. A later pass carried it to the
  REVIEW surfaces the first sweep missed (companion verdicts in `StepMetadataCard.vue`, the judge
  summary + findings, best-practice adherence, the PR-review summary/findings, the tester report),
  paired with the prompt half so those verdicts arrive as blocks in the first place, and stopping at
  the fields that carry a VALUE rather than prose: see the two conventions below.
- **UX-44: Result-view polish. PARTIAL (copy affordances done).** Copy buttons
  (`common/CopyButton.vue`) now sit on the pretty-printed JSON block
  (`GenericStructuredResultView.vue`) and on the consensus synthesis + each round contribution
  (`ConsensusSessionWindow.vue`). **Still todo:** jump-to-latest in the live consensus stream,
  and timestamps on review findings/answers so a re-summoned user can tell what's new.

## D. Settings, keys & integrations

| ID    | Sev | Status  | Finding                                                                                            |
| ----- | --- | ------- | -------------------------------------------------------------------------------------------------- |
| UX-45 | P1  | todo    | Direct provider API keys saved without any validation probe                                        |
| UX-46 | P2  | todo    | Connected keys show no last-4 / created-date identity hint                                         |
| UX-47 | P2  | todo    | Key-removal confirm is generic: doesn't name the key                                               |
| UX-48 | P2  | todo    | Datadog/incident connections: no Test button, no key-page links, no scopes stated                  |
| UX-49 | P2  | partial | 428 password modal never explains the 40h client-side password caching                             |
| UX-50 | P2  | todo    | Model pickers are unsearchable dropdowns (catalog can be 300+ models)                              |
| UX-51 | P2  | partial | Merge presets: % semantics not shown; no "used by" / default hint                                  |
| UX-52 | P2  | todo    | High-blast-radius disconnects (GitHub App) are one accidental Enter away                           |
| UX-53 | P2  | todo    | No unsaved-changes protection in settings panels (tab switch / Escape discards)                    |
| UX-54 | P3  | todo    | Manual GitHub installation-id field gives no hint where the id comes from                          |
| UX-55 | P3  | todo    | Vendor credential steps are plain text, no "create token" link                                     |
| UX-56 | P3  | todo    | Mixed save granularity inside WorkspaceSettingsPanel (one Save for 5 sections; Budget separate)    |
| UX-57 | P3  | done    | Raw backend error text piped verbatim into toasts/status across settings                           |
| UX-58 | P3  | todo    | Local runner endpoints savable without a (re)successful test after URL edits                       |
| UX-59 | P3  | todo    | Slack member map requires hand-pasting raw `Uxxxx`/GitHub ids, no lookup                           |
| UX-60 | P3  | partial | Password modal doesn't name the run/task it gates; expiry date field doesn't state its consequence |
| UX-61 | P3  | todo    | AI-onboarding modal: no explicit skip/later button; operator note nearly invisible                 |

- **UX-45: Unvalidated keys.** `providers/ApiKeysSection.vue:179` +
  `stores/apiKeys.ts:38-43`: pasting a direct key POSTs and toasts "Connected"
  without a probe, so a typo'd/expired key looks configured and fails later at run
  dispatch, far from the cause. `OpenRouterCatalogPanel.vue:118-165` already
  implements probe-then-rollback; `UserSecretsSection`/`LocalModelEndpointsPanel`/
  `ProviderConnectionTab` have Test buttons. Fix: same probe-before-success path.
- **UX-46: Anonymous keys.** `ApiKeysSection.vue:356-367`: a key row shows only
  the user label + usage; two keys for one provider are indistinguishable. Fix:
  last-4 suffix + created timestamp.
- **UX-47: Generic delete confirm.** `ApiKeysSection.vue:212-213` passes the
  generic noun to `confirmAction('remove', …)`; `VendorCredentialsModal.vue:143-150`
  does it right (interpolates `cred.label`).
- **UX-48: Blind Datadog save.** `ObservabilityConnectionPanel.vue:112-131`
  (+ incident block :256-269), no Test, no link to the vendor's key page, no
  scopes stated; failures surface only when the post-release-health gate silently
  can't read monitors.
- **UX-49: Undisclosed password cache.** `providers/PersonalCredentialModal.vue:110-121`
  vs `stores/personalSubscriptions.ts:31-32,117-127`: the password is cached in
  localStorage for ~40h, but the modal never says so, making the re-prompt cadence
  feel random and hiding a disclosure users should get. Fix: one line of copy
  (+ optionally a "don't remember" choice).
- **UX-50: Unsearchable model pickers.** `settings/ModelConfigurationPanel.vue:168-176`
  (base) and `:179-194` (per-agent override) render the full `selectableModels`
  list with no filter, while the _agent-kind_ list right below has one (`:453`).
  With OpenRouter enabled the list can exceed 300 entries. Related: the OpenRouter
  browse list itself renders unvirtualized (`OpenRouterCatalogPanel.vue:75-81,346-348`)
  and janks on mount; cap, filter-first, or virtualize.
- **UX-51: Opaque preset semantics.** `settings/MergeThresholdsPanel.vue:234-306`
  edits thresholds 0–100 with no `%` unit (stored 0–1, :88-90), and nothing shows
  which tasks use a preset or which is the workspace default.
- **UX-52: One-click GitHub disconnect.** `github/GitHubPanel.vue:49-63` (also
  Slack :111-125, presets, keys) all use the simple accept/cancel
  `useConfirm`. For the App the whole board depends on, require typing the name.
- **UX-53: Settings lose edits.** `WorkspaceSettingsPanel.vue` (draft :109-120),
  `MergeThresholdsPanel.vue` (drafts :46), `SlackPanel.vue` (:43-59) all hold local
  edits discarded on Escape/backdrop/tab-switch with no warning. (Same theme as
  UX-18/UX-33.)
- **UX-49: Undisclosed password cache. PARTIAL (re-verified 2026-08-18).**
  `personalCredential.passwordBody` now discloses the cache exists ("so you won't
  be asked again for a while") but not its ~40h duration
  (`stores/personalSubscriptions.ts:48-49`), and there is still no "don't
  remember" opt-out (`cachePassword` is unconditional).
- **UX-51: Opaque preset semantics. PARTIAL, surface renamed.**
  `MergeThresholdsPanel` became the risk-policy library (`settings/RiskPolicyPanel.vue`
  - `RiskPolicyEditorRow.vue`, #958). Fixed there: the field labels carry the `%`
    unit and the panel intro explains 0-100 scoring; default / unattended-default
    badges with promote buttons exist. Still open: nothing shows which tasks USE a
    policy.
- **UX-57: Raw error toasts. DONE.** The `usePipelineErrorToast().present()` funnel
  now translates every failure title + status-class/reason description, keeps the
  backend prose, validation issues and `requestId` behind a "Show details"
  disclosure, and makes the toast sticky and copyable. All six surfaces named by
  the audit route through it, and `settings/ConnectionTestVerdict.vue` gives inline
  probe verdicts a translated headline with the raw prose demoted to a detail line.
- **UX-60: PARTIAL.** Renewal nudges now exist (`renewalNotices`, "expired / renews
  in N days") and the field is labeled "Subscription renews on (optional)", but the
  field still has no `:description` stating the consequence, and the 428 modal
  still names only the vendor, never the gated run/task (`pending` carries
  `vendor`/`reason`/`retry` only).
- **UX-54/55/56/58/59/61: smaller settings polish, all still open (re-verified
  2026-08-18).** Manual installation-id field (`github/GitHubConnect.vue:169-184`)
  needs a "where do I find this" link; `VendorCredentialsModal.vue:234-239` steps
  should link the vendor console (`ApiKeysSection.vue:323-332` shows the pattern);
  `WorkspaceSettingsPanel.vue` now has TEN sections behind one Save (`:650-657`)
  while eight sibling tabs save their own way, so UX-56 got worse;
  `LocalModelEndpointsPanel.vue:219-243` still saves an endpoint whose URL changed
  since the last green probe (`tested` is only reset by `seedDraft`);
  `SlackPanel.vue:327-339` member ids are hand-typed with placeholders only;
  `AiProviderOnboardingModal.vue:121-123` still buries the operator note at
  `text-[11px]` and offers no explicit skip.

## E. Async state, realtime & error surfacing

| ID    | Sev | Status | Finding                                                                                 |
| ----- | --- | ------ | --------------------------------------------------------------------------------------- |
| UX-70 | P1  | done   | Board whose WebSocket never connects is silently non-live, no indicator                 |
| UX-71 | P2  | done   | Debounced board refresh swallows failures → silently stale board                        |
| UX-72 | P2  | done   | Reconnect declares "connected" even when the resync refresh failed                      |
| UX-73 | P2  | done   | Preview polling stops silently on transient error → stuck "Starting…" forever           |
| UX-74 | P2  | done   | Service-spec window error state has no retry                                            |
| UX-75 | P3  | done   | Observability panel error has no retry; context-load failure masquerades as empty state |
| UX-76 | P3  | done   | `removeDependency` has no error handling (sibling `toggleDependency` does)              |
| UX-77 | P3  | done   | Actionable error toasts auto-dismiss, taking their remedy button with them              |

- **UX-70: Never-connected is invisible. DONE.** `useWorkspaceStream` now tracks the
  per-workspace connection lifecycle (`everConnected` + `connectionFailed`, reset on
  `start()`): after `INITIAL_FAIL_ATTEMPTS` (3) failed connects with no successful handshake it
  flags `connectionFailed`, and `ConnectionStatusBanner` renders a distinct rose "not receiving
  live updates" strip (`data-testid="stream-offline"`, `i-lucide-wifi-off`); separate from the
  amber reconnecting strip (which only shows once we HAVE been live). The banner's local
  `everConnected` tracking moved into the stream (passed as props) so both variants read the same
  source of truth.
- **UX-71: Swallowed coarse refresh. DONE.** `debouncedBoardRefresh` now routes through
  `refreshWithRetry(workspaceId)` (up to `REFRESH_MAX_ATTEMPTS`, backoff 0.4→4s), aborting between
  attempts if the stream stopped or the workspace switched: one transient failure no longer leaves
  the board silently stale.
- **UX-72: Optimistic reconnect. DONE.** The on-`open` resync uses the same
  `refreshWithRetry` instead of `refresh().catch(() => {})`, so a reconnect whose first reconcile
  fails now retries rather than presenting as fully live while missing the outage's events.
  `connected` is still flipped even if every retry fails (we ARE connected; a refresh error must
  not wedge the indicator / the e2e `data-connected` gate).
- **UX-73: Preview stuck forever. DONE.** `stores/preview.ts` `refresh` now, on a poll-tick
  error while the last known state is `starting`, keeps polling up to `POLL_MAX_ERRORS` (5), so a
  transient blip self-heals, then surfaces the error into `requestError` and stops, instead of
  silently wedging the amber "Starting…" forever. A successful tick resets the per-frame error
  counter.
- **UX-74, No retry on spec load. DONE.** `spec/ServiceSpecWindow.vue`'s error state gained a
  Retry button (`common.retry`, `:loading` bound to the store's loading flag) calling
  `serviceSpec.load(blockId)`.
- **UX-75: Observability gaps. DONE.** `stores/observability.ts` now records
  `contextErrors[executionId]` on a `loadContext` failure (cleared on each attempt); the panel's
  context view shows a distinct error-with-retry state (`observability.contextError` + Retry)
  before the `noContext` empty state, so a fetch failure no longer masquerades as "no context
  stored". The calls view's existing error state also gained a Retry (`observability.load`).
- **UX-76: Unhandled removeDependency. DONE.** `stores/board.ts` `removeDependency` is now
  wrapped in try/catch mirroring `toggleDependency`, toasting `board.toast.unlinkFailed` on
  failure instead of rejecting unhandled with no feedback.
- **UX-77: Vanishing remedies. DONE.** The two action-bearing conflict toasts in
  `usePipelineErrorToast` (`providers_unconfigured` → "Configure AI",
  `binary_storage_unconfigured` → "Configure storage") now set `duration: 0` so the one-click
  remedy stays reachable instead of auto-dismissing (~5s). Non-actionable toasts keep the default.

## F. Accessibility, keyboard & theming

| ID    | Sev | Status      | Finding                                                                                  |
| ----- | --- | ----------- | ---------------------------------------------------------------------------------------- |
| UX-62 | P1  | done (#841) | Icon-only close/action buttons with no accessible name (widespread)                      |
| UX-63 | P2  | done (#841) | No single labeling convention for icon buttons (title-only vs aria-only vs both vs none) |
| UX-64 | P2  | done (#841) | Clickable non-interactive `<div>` steps on board cards, not keyboard-operable            |
| UX-65 | P2  | done (#841) | Color-only focus indicator on hand-rolled inputs (`outline-none` + border-hue swap)      |
| UX-66 | P2  | done (#841) | Animations ignore `prefers-reduced-motion` (infinite board pulses, marching ants)        |
| UX-67 | P2  | todo        | No light mode / system color-scheme support; palette hardcoded                           |
| UX-68 | P3  | todo        | Keyboard-shortcuts cheatsheet lists 4 shortcuts; others undocumented                     |
| UX-69 | P3  | todo        | Board nodes not in the tab order, no keyboard path to a specific card                    |

- **UX-62: Unlabeled icon buttons. DONE.** Every icon-only dismiss button that had
  neither `aria-label` nor `title` now routes through the new shared `common/IconButton.vue`
  primitive with `:label="t('common.close')"`: `focus/BlockFocusView.vue`,
  `clarity/ClarityReviewWindow.vue`, `brainstorm/BrainstormWindow.vue`,
  `panels/InspectorPanel.vue`, `spec/ServiceSpecWindow.vue`,
  `requirements/RequirementsReviewWindow.vue`. (The `AgentStepDetail` /
  `ObservabilityPanel` / `ModelConfigurationPanel` / `PipelineBuilder` X buttons were
  already `:title`-labeled and were left as-is; the `DocumentTemplatesModal` remove
  buttons carry visible "Remove" text so they're already named.)
- **UX-63, No convention. DONE.** The convention is now a component, not a habit:
  `common/IconButton.vue` (mirroring `common/CopyButton.vue`) requires a `label` prop
  and applies it as BOTH `:title` (pointer tooltip) and `:aria-label` (screen readers),
  passing every other UButton prop/listener through via `$attrs`. An icon-only button
  with no accessible name is now unrepresentable through the primitive. (No `UTooltip`
  exists in the app; `title`+`aria-label` is the established named-icon pattern
  ( `StepContainerStatus.vue`) so IconButton codifies exactly that.)
- **UX-64: Keyboard-dead click target. DONE.** `board/nodes/TaskPipelineMini.vue`'s
  clickable `<div>` mini-step is now a real `<button type="button">` (keyboard-focusable
  - operable), with `focus-visible:ring-2` and `text-start w-full` to preserve layout.
- **UX-65: Invisible focus. DONE.** The hue-only raw inputs now add
  `focus-visible:ring-2 focus-visible:ring-<hue>/60` (hue matching each surface's accent)
  alongside the existing `focus:border-*`: `humanTest/HumanTestWindow.vue`,
  `followUp/FollowUpWindow.vue`, `gates/GateResultView.vue`, and both textareas in
  `visualConfirm/VisualConfirmationWindow.vue`.
- **UX-66: Motion never reduced. DONE.** A `@media (prefers-reduced-motion: reduce)`
  block in `assets/css/main.css` disables the decorative infinite pulses (`board-pulse`,
  `board-pulse-green`) and the marching-ants edge animation; the matching pair in
  `pipeline/PipelineProgress.vue`'s scoped styles (`step-active`, `followup-blink`) does
  the same. Loading spinners (`animate-spin`) are deliberately untouched: a spinner's
  motion IS its meaning.
- **UX-67: Dark-only.** Zero `dark:`/`useColorMode`/`prefers-color-scheme`
  matches; palette hardcoded to slate/`#0b1020` (`main.css:14-16`) with only a
  `--board-bg` variable. Light/high-contrast users have no option. At minimum,
  expose the palette as CSS variables to make theming possible.
- **UX-68: Sparse cheatsheet.** `common/KeyboardShortcutsHelp.vue:23-28` lists
  ⌘K/Esc/Del/`?` only; the lightbox shortcuts and the intentional
  Delete-not-Backspace subtlety (`useKeyboardShortcuts.ts:70-79`) are undocumented.
- **UX-69: Untabbable board.** Vue Flow nodes are pointer-first; there is no
  keyboard path to select/open a specific card (⌘K exists but doesn't cover
  spatial selection). Consider a roving tabindex or command-bar coverage, or
  document the command bar as the keyboard entry point. (Pairs with UX-12.)

---

Sections G-K are the 2026-08-18 sweep of surfaces added after the first audit.
Anchors are from that date.

## G. Result windows & gate surfaces (2026-08-18)

| ID    | Sev | Status | Finding                                                                                  |
| ----- | --- | ------ | ---------------------------------------------------------------------------------------- |
| UX-78 | P1  | done   | Review-friction "Create anyway" double-submits: two tasks, two runs                      |
| UX-79 | P1  | done   | Fork-decision / follow-up / binary-candidates / initiative-review windows discard drafts |
| UX-80 | P1  | done   | Binary-candidates gate: cards not keyboard-operable; blank body when state is missing    |
| UX-81 | P1  | todo   | CreateInitiativeModal lacks the unsaved guard its sibling AddTaskModal has               |
| UX-82 | P2  | done   | Initiative-planning / doc-interview persists fail silently (no toast, no state)          |
| UX-83 | P2  | todo   | Typed text cleared before the call settles; stack edit overwrites the add form           |
| UX-84 | P2  | todo   | Initiative checkpoint Cancel and PR-review finding Dismiss are unconfirmed               |
| UX-85 | P3  | todo   | PR-review Post/Finish lack `:loading`; follow-up Dismiss missing the permission gate     |

- **UX-78: Friction-dialog double submit. DONE.** The friction context now carries a
  `pending()` GETTER over the opener's own `saving` ref (a copied boolean would be
  frozen at `false`: the context object is captured once at open), which the dialog
  reads inside a `computed` to drive `:loading`/`:disabled` on "Create anyway".
  `submitCreate` also got the authoritative half, an entry guard on `saving`, so the
  refusal holds for any future caller of that second entry point.
- **UX-79: Draft loss on close. DONE, and wider than the four surfaces above.** A
  systematic pass over every `ResultWindowShell` consumer found **fourteen** windows
  holding unsubmitted input and only two (requirements, clarity) handling it. All
  fourteen now do, split by what the draft's submit button actually does:
  - **flush** (`useResultView({ onClose })`) where recording a draft is a PLAIN SAVE
    that decides nothing: requirements, clarity, and the two interview windows (whose
    `persist` now takes the block id explicitly, because `blockId` goes null the
    moment the view tears down and a close-time flush would otherwise write nowhere).
    The initiative planner's interviewer is the fourteenth window, and it was found by
    the guard rather than by a sweep: it holds the same per-question answers as the doc
    interview through `ClarificationItem`'s `v-model:answer`, which the first version of
    the inverse assertion could not see.
  - **confirm** (`useUnsavedGuard` in front of the shell's close) where the only
    button carrying the draft also RESOLVES something: fork-decision, follow-up,
    binary-candidates, the initiative tracker, judge, PR-review, brainstorm, the
    human-review gate, human-test and visual-confirm. Auto-sending on Escape was
    never an option here: it would spend a bounded chat turn, keep an artifact, or
    resolve a parked gate on the user's behalf.
    The initiative tracker's drafts live two components down, so `InitiativePlanReview`
    and `InitiativePlanDecision` report dirtiness upward through `update:dirty`
    (retracted on unmount, so a resolved gate can't leave the host holding a stale flag).
    `ResultWindowDrafts.logic.spec.ts` is the enforcement hook (theme 8): it names every
    window's disposition, fails on a stale or missing row, asserts POSITIVELY that each
    window is wired to the seam its disposition names, AND fails on a window declared
    draft-free that holds any state binding or native control. Those two assertions found
    the gate/human-test/visual-confirm three and then the planning window, none of which a
    manual sweep had listed.
- **UX-80: Binary-candidates gate blocked for keyboard users. DONE.** Each card now
  carries a real labelled `<input type="radio"|"checkbox">` (the window is ONE radio
  group, because `toggle` replaces the selection across every subject rather than per
  group). The card's pointer handler stays, so `@click.stop` has to shield it from the
  LABEL rather than from the input: activating a label FORWARDS a synthetic click to its
  input, which `.stop` on the input does not prevent, so a click on the label text
  toggled via the card and then toggled back via the forwarded change. On a checkbox that
  nets to no change, so no re-render, so the box stays ticked over a candidate that is no
  longer selected and Keep quietly keeps the wrong set.
  The blank body is now four branches, not one: `binaryCandidateAbsence()` (pure, tested)
  states the precedence. No RUN outranks everything (the window is keyed to an execution
  and the warm-up read is skipped without one, so the store's flags describe somebody
  else's read and emptiness would be a claim about a run nobody looked at); an in-flight
  read outranks a stale error so a Retry isn't showing the failure it is clearing; and a
  recorded error outranks emptiness so a request that never landed cannot render as "this
  run compared nothing". The store gained the `loading` flag, records its load failure for
  the Retry, and SEQUENCES its attempts, because a slow failure settling after a fast
  success used to report a load failure over candidates already on screen.
- **UX-81: Unguarded initiative modal.** `board/CreateInitiativeModal.vue:37-42`
  closes straight through the store: Escape/backdrop discards title, goal, every
  descriptor field and staged context attachment, and the `watch(open)` reset wipes
  them on reopen. Wire `useUnsavedGuard` (`AddTaskModal.vue:615` is the model).
- **UX-82: Silent persist failures. DONE, and the two windows now share one seam.** Both
  held byte-identical draft logic and were only ever fixed one at a time, which is how the
  doc interview grew a close-time flush while the planner kept dropping answers on close.
  `useInterviewDrafts` is that logic once: it seeds the drafts, saves one on blur, flushes
  the dirty ones on the way out, and reports every failure through
  `usePipelineErrorToast().present`. Three things it fixes that a per-window copy kept
  losing: each answer settles INDEPENDENTLY (the old loop awaited straight through, so one
  rejection dropped every answer after it, with the window already gone); the report names
  HOW MANY were lost, because a close-time flush is the only path with no button left on
  screen; and a pre-action flush WITHHOLDS the action when a write failed, rather than
  submitting a missing answer as if it were there. It also renders the one case neither
  window could ever save: `id` is optional on both wire shapes and the answer write
  addresses a question BY id, so an exchange without one has its input disabled and says
  why, and is excluded from the unanswered count that would otherwise disable Submit for
  good.
- **UX-83: Typed text cleared too early. PARTIAL.** Two of the four sites are fixed,
  both in files the UX-79 slice already touched: `prReview/PrReviewWindow.vue`'s challenge
  box and `forkDecision/ForkDecisionWindow.vue`'s chat box (a fourth site the original
  entry did not list, found while reviewing that slice) now clear only on the success
  path, so a failed send costs nothing and the inline error strip says what happened.
  Still open: `settings/RiskPolicyCreateForm.vue:36-54` clears the name on emit, before
  the parent's create settles; `settings/SharedStacksPanel.vue:117-131` `startEdit`
  overwrites the add form in place, discarding whatever was typed there. Fix: clear on the
  success path only; confirm before repurposing a dirty form.
- **UX-84: Unconfirmed NO_GO.** The checkpoint Cancel button
  (`initiative/InitiativeTrackerWindow.vue:343-349`) stops the whole initiative's
  execution loop on one click, sitting directly beside Resume; the per-finding
  Dismiss in `PrReviewWindow.vue:747-755` removes a reviewer finding entirely with
  no confirm and no undo. Route both through `useConfirm({ variant: 'destructive' })`.
- **UX-85: Missing pending/permission affordances.** Only "Fix" carries `:loading`
  in `PrReviewWindow.vue:823-842` (Post and Finish just grey out, reading as dead
  buttons); the follow-up branch's Dismiss (`followUp/FollowUpWindow.vue:238-246`)
  is the one action in its window missing the `canExecuteRuns` disable + title, so
  a viewer-role user learns from a raw inline error.

## H. Environment wizard & foundational services (2026-08-18)

| ID    | Sev | Status | Finding                                                                               |
| ----- | --- | ------ | ------------------------------------------------------------------------------------- |
| UX-86 | P1  | todo   | Wizard "Done" is always enabled beside Save and discards the whole recipe             |
| UX-87 | P2  | todo   | Analysis wedges on "running" forever when the run is done but the draft unparseable   |
| UX-88 | P2  | todo   | Review step: raw-editor toggle and "Apply analyst draft" silently discard edits       |
| UX-89 | P1  | todo   | Foundational manager tab switch destroys the registry draft (UTabs unmount default)   |
| UX-90 | P2  | todo   | Registry form: index-keyed contract rows, unconfirmed Cancel, unexplained Save lock   |
| UX-91 | P2  | todo   | Foundational/skill-library loads render any failure as "not wired on this deployment" |
| UX-92 | P3  | todo   | Preflight badge shows the raw pass/warn/fail enum; review-step Next has no reason     |

- **UX-86: Done discards the recipe.** `environments/steps/EnvSaveStep.vue:95-107`:
  `exit('advance')` completes the journey and clears its persisted blob whether or
  not Save ran, sitting directly beside Save. Gate Done on `store.saved`, or confirm
  when `!store.saved`.
- **UX-87: Analysis spinner can wedge forever.** `stores/environmentWizard.ts:165-172`:
  only `run.status === 'failed'` maps to `failed`, so a run that finishes `done` with
  an absent/unparseable `result.custom` leaves `analysisStatus` at `running`, the
  review step spinning and its button disabled with no error and no retry. Treat
  done-with-no-draft as `failed`.
- **UX-88: Review-step edits silently replaced.** `EnvReviewStep.vue:96-99`: closing
  the raw-recipe editor drops `rawText` (reopening re-serialises from the store), so
  hand-edited JSON never "Applied" vanishes; `:200-209` "Apply analyst draft" replaces
  the recipe wholesale (`stores/environmentWizard/flow.ts:69-74`), discarding the
  compose-file/profile/seed toggles already set, with no warning, no undo and no
  toast saying what changed.
- **UX-89: Tab switch destroys the foundational draft.**
  `foundational/FoundationalServiceManager.vue:91-119`: @nuxt/ui `UTabs` defaults
  `unmountOnHide: true`, so switching from the registry tab and back destroys
  `FoundationalServiceRegistry`'s draft, including pasted OpenAPI contract bodies.
  Set `:unmount-on-hide="false"` or lift the draft into a store. (Check every other
  `UTabs` holding form state for the same trap.)
- **UX-90: Registry form integrity.** `FoundationalServiceRegistry.vue:281`: contract
  rows are `v-for` keyed by index with `removeContract(i)` (the UX-23 rebind bug, on
  pasted contract documents); Cancel (`:317-326`) discards the whole draft with no
  confirm; Save is disabled by one aggregate `draftValid` with no per-field or
  summary explanation of what is missing.
- **UX-91: Failure rendered as "unavailable".** `stores/foundationalServices.ts:107-119`
  and `stores/skillLibrary.ts:64-65` set `available = false` on ANY error, so a
  transient 500 renders the "deployment has not wired this" copy with no retry: the
  exact misattribution the UX-77 reason-copy rule exists to prevent. Split settled
  503 from transient failure (the `capabilityCredentials`/`toolServers`/`publicApiKeys`
  stores are the in-tree pattern). The same conflation exists across ~15 availability
  probes; the review-window stores (`requirements`/`clarity`) are the sharpest,
  since a blip on open leaves a reviewer looking at an un-advanceable empty gate.
- **UX-92: Raw enum + unexplained lock.** `EnvPreflightStep.vue:85-87` renders
  `{{ r.status }}` (`pass|warn|fail`) raw while mapping the same enum to a colour two
  lines above; `EnvReviewStep.vue:369-377` "Next" is disabled with no title and the
  body is `v-if`-hidden when detection produced nothing, so the disabled button is
  the only thing on screen.

## I. Destructive actions & per-row feedback (2026-08-18)

| ID    | Sev | Status | Finding                                                                                      |
| ----- | --- | ------ | -------------------------------------------------------------------------------------------- |
| UX-93 | P1  | done   | Pipeline-health Delete/Remove is unconfirmed and irreversible                                |
| UX-94 | P1  | done   | Test-secret rows keyed by index: a middle-row delete can save the wrong secret under a key   |
| UX-95 | P2  | todo   | One-click destructives: stack Stop, tutorial reset, template unlink, MCP disconnect, archive |
| UX-96 | P2  | todo   | More index-keyed editable rows: validation commands, frontend bindings, failure-kind rules   |
| UX-97 | P2  | todo   | One shared busy flag spins every row's buttons on five panels                                |
| UX-98 | P3  | todo   | Immediate-persist config unlinks with no confirm                                             |
| UX-99 | P3  | todo   | Member role/access-mode changes are silent; the access-mode widen is unconfirmed             |

- **UX-93: Unconfirmed irreversible delete. DONE.** Both removal buttons route through
  one `confirmRemove` on `useConfirmAction`'s `remove` shape, which NAMES the pipeline
  (the two sections render rows of near-identical buttons, and "which one did I just
  delete" is unanswerable afterwards). The shared `run` helper now reports whether the
  action settled, so the success toast is withheld on a refusal rather than claiming a
  delete the 409 refused. An OPEN confirm also locks the screen, tracked apart from
  `busy` so the row doesn't spin while the human reads the prompt: `useConfirm` is a
  singleton, so a second Delete click superseded the pending request and settled it
  `false`, which silently did not delete the first pipeline.
- **UX-94: Mis-keyed secret rows. DONE.** Each draft row carries a stable client-only
  `uid` (the UX-23 convention) that the `v-for` keys on, and `removeRow` takes that uid
  rather than an index, so the removal can never be read against a stale position.
- **UX-95: One-click destructives.** `settings/SharedStacksPanel.vue:316-327` "Stop"
  tears down workspace-wide infra that live previews attach to (the Delete beside it
  IS confirmed); `tutorial/TutorialCatalogue.vue:140-150` "Reset progress" wipes
  local AND server progress; `documents/DocumentTemplatesModal.vue:77` unlinks a
  template/exemplar from an X button; `settings/ToolServerChecklist.vue:81` revokes
  an MCP OAuth grant (re-granting is a full vendor round-trip);
  `sandbox/SandboxPanel.vue:254,620` archives a candidate prompt, from a button that
  is also an unlabeled red icon. All want `useConfirm`/`confirmAction` naming the
  target.
- **UX-96: More index-keyed rows.** `panels/inspector/ServiceValidationConfig.vue:242`,
  `panels/inspector/FrontendConfig.vue:552` (blur-committed by index), and
  `layout/AccountFailureKindRules.vue:177` (`patch(index, ...)`), plus the registry
  rows in UX-90. Same fix as UX-23/94.
- **UX-97: Shared busy flag.** One `busy` ref bound to every row's `:loading`/
  `:disabled`: `settings/ApiTokensPanel.vue:286`, `settings/ConsensusGroupsSection.vue:264`,
  `documents/DocumentTemplatesModal.vue:157,194,220,231` (rows cross-spin with both
  submit buttons), `settings/PackageRegistriesPanel.vue:145,209`,
  `layout/WorkspaceMembersSettings.vue:191,200,235` (removing one member greys every
  role select). The UX-29 `withRow` per-key pattern is already re-implemented in
  `PipelineHealthModal.vue:31-48`; extract and reuse it.
- **UX-98: Unconfirmed config unlinks.** `panels/inspector/ServiceConnections.vue:66`,
  `panels/inspector/FrontendConfig.vue:105`, `panels/inspector/TaskAprioriBranches.vue:96`,
  `settings/ServiceFragmentDefaultsPanel.vue:50` each PATCH away named user work on
  first click. Low blast radius (re-addable), so a confirm or an undo toast.
- **UX-99: Silent membership changes.** `layout/WorkspaceMembersSettings.vue:80-101`:
  `updateRole` and `setAccessMode` produce no toast (add and remove both do), and
  flipping the access mode instantly opens a restricted board to every account
  member with no confirmation.

## J. Failure rendered as absence, in stores (2026-08-18)

Extends section E to loaders added after it landed. The compliant shape is in-tree:
`prReview`/`forkDecision`/`judge`/`binaryCandidates` record an error their window
renders with Retry.

| ID     | Sev | Status | Finding                                                                            |
| ------ | --- | ------ | ---------------------------------------------------------------------------------- |
| UX-100 | P2  | todo   | Loads with no error state render as confident empty claims (7 stores)              |
| UX-101 | P2  | todo   | Search-query telemetry load swallowed while all four sibling loaders record errors |
| UX-102 | P2  | todo   | environments.load failure flips every service binding to "service offline"         |
| UX-103 | P2  | todo   | Merge track-record load failure reads as "no data yet" under the auto-merge editor |
| UX-104 | P2  | todo   | Failed loads misattributed: wrong toast key, or toast-then-empty-state             |
| UX-105 | P2  | todo   | Fire-and-forget mutations: confirmed deletes and initiative controls fail silently |

- **UX-100: Empty claims over failed loads.** No catch and no error ref, so the empty
  state claims "none exists": `stores/docInterview.ts:34-38` ("no session yet" over a
  run genuinely parked on interviewer questions), `stores/consensus.ts:60-61` ("no
  consensus session ran" over a failed transcript fetch), `stores/initiative.ts:153-164`
  and `stores/kaizen.ts:80-83,106-109` (rethrow anything non-503 into a `void` call),
  `stores/github.ts:136-151` (the panel then says the installation grants access to
  no repositories), `stores/vendorCredentials.ts:23-32` ("no vendor credentials
  connected", inviting a duplicate paste of a live token), `stores/apiKeys.ts:23-36`
  (`.catch(() => ({ keys: [] }))` with no comment, plus a try/finally-only `load`).
- **UX-101: The one swallowed telemetry loader.** `stores/observability.ts:191-192`:
  `loadSearchQueries` is a bare catch while all four sibling loaders in the same
  store record per-key errors with Retry; `observability.noSearch` then affirms the
  agent performed no web searches. Mirror `loadContext` (UX-75).
- **UX-102: Bindings misread an outage.** `stores/environments.ts:28-38` keeps
  last-known handles on error, which on FIRST load is the empty list, so
  `FrontendBindingsResolved.vue:102-104` renders every service-sourced binding as
  the amber "service offline" row from a request that never landed. Record a
  `loadError` and render "could not resolve bindings" with Retry.
- **UX-103: Auto-merge evidence reads "none".** `stores/mergeTrackRecords.ts:39-48`
  is try/finally only and `byClass` zero-fills, so `settings/MergeClassRulesEditor.vue:118-120`
  shows "no data yet" on every change class exactly where an operator decides to
  widen an auto-merge rule; three call sites `void` the load. Record a failure and
  leave `loaded` false so "not fetched" and "no records" stay distinct.
- **UX-104: Misattributed load failures.** `settings/TaskTypeSuppressionsPanel.vue:34,71-73`
  reports a failed LOAD with the `saveFailed` key, then renders "no operations
  registered"; `layout/AccountRiskPolicySettings.vue:38-44,104-106` toasts then tells
  an admin the account has no merge policies; `documents/DocumentTemplatesModal.vue:36-38,99-110`
  toasts then offers "Import a document first" for documents that exist. Each needs a
  failed-read branch + Retry (`RiskPolicyPanel.vue:224-230` has one).
- **UX-105: Fire-and-forget mutations.** `composables/usePipelineLibraryActions.ts:64`:
  `void pipelines.removePipeline(p.id)` after the destructive confirm, and the store
  doesn't catch, so a failed delete leaves the row in place with no word (the file's
  own docstring claims each action reports its failure); the same file's `:27-29,76-78`
  hand-build bare error toasts while `:46` correctly uses `present`.
  `panels/inspector/InitiativeInspector.vue:44-46` `void initiatives.control(...)`:
  Pause/Resume/Cancel on a running initiative can fail with the badge never changing
  and no toast.

## K. Convention adoption gaps, systemic (2026-08-18)

The re-audit's headline (cross-cutting theme 8): the primitives all exist; the
surfaces built after them don't use them.

| ID     | Sev | Status | Finding                                                                             |
| ------ | --- | ------ | ----------------------------------------------------------------------------------- |
| UX-106 | P2  | todo   | Icon-only UButtons with no accessible name: 26 sites in 19 files; IconButton in 4   |
| UX-107 | P2  | todo   | Disabled controls whose reason lives only in `:title` (64 sites of one predicate)   |
| UX-108 | P2  | todo   | Agent prose still raw `whitespace-pre-wrap` in ~17 sites across 12 files            |
| UX-109 | P2  | todo   | Keyboard-dead clickable elements (7 sites; one is the only way to open step detail) |
| UX-110 | P2  | todo   | Raw internals rendered: agent-kind enums, model refs, server/item/run ids           |
| UX-111 | P3  | todo   | Stragglers: one bare password input, one raw error toast, hover-only controls       |

- **UX-106: IconButton unadopted.** `common/IconButton.vue` is imported by 4
  components; 26 icon-only `<UButton icon>` sites across 19 files carry no label,
  title or aria-label (worst offenders: `FragmentLibraryManager` x5,
  `TaskRunSettings` x4, `BootstrapModal` x2; several are destructive trash glyphs),
  plus three fully-raw icon buttons (`context/ContextAttachmentFields.vue:291,399`,
  `pipeline/PipelineBuilder.vue:493`). Sweep them through the primitive; consider a
  lint rule so the count stops regrowing. The title-only holdouts UX-62 left as-is
  can join opportunistically.
- **UX-107: Reasons trapped in `:title`.** 64 occurrences of
  `:title="t('access.noRunExecute')"` across 19 files sit on disabled controls with
  the reason rendered nowhere visible; a disabled button never fires hover (the
  UX-40 rule), so a viewer-role user sees every gate action greyed with no stated
  why. One shared visible hint per action rail, derived from the same
  `access.canExecuteRuns` predicate. Same defect with other reasons:
  `docs/DocInterviewWindow.vue:258-259` (`continueBlockedReason` bound only to
  title), `settings/ConsensusGroupsSection.vue:374-382` (the min-2-participants rule
  unstated), `board/nodes/InitiativeCard.vue:139-152` (planning preset missing: the
  only start affordance is permanently disabled and the title restates the label).
- **UX-108: Prose still flat.** Model-written markdown rendered as plain text: the
  doc-interview converged brief (`DocInterviewWindow.vue:185-188`, a `<pre>`), fork
  approaches and agent chat turns (`ForkDecisionWindow.vue:216,288`), follow-up
  detail (`FollowUpWindow.vue:153`), clarification detail/recommendation
  (`common/ClarificationItem.vue:60,142`), effort and reproduction report summaries
  (`StepEffortReport.vue:69,78`, `StepReproductionReport.vue:84,93`), initiative
  goal/analysis (`InitiativeTrackerWindow.vue:363,387`, `InitiativeInspector.vue:60`),
  ralph attempt summaries (`RalphLoopResultView.vue:237`), the gate helper's report
  (`GateResultView.vue:426`). The value-vs-prose rule stands: `suggestedFix` and the
  `lastFailureSummary` blocks correctly stay preformatted.
- **UX-109: Keyboard-dead click targets.** `pipeline/PipelineProgress.vue:339` (the
  `<div @click>` step row is the ONLY way to open a step's detail; UX-42 fixed the
  restart button inside it but not the row), `media/ImageCompare.vue:220,228` (a
  hover-only `<span @click>` NESTED inside a button, invalid interactive HTML, plus
  a `<div>` drop zone), `panels/inspector/ContainerSummary.vue:36,68` (`<li @click>`
  rows), `panels/StepRunMeta.vue:135` (a click-to-copy `<p>`; should be
  `CopyButton`), `sandbox/SandboxPanel.vue:482` (`<tr @click>`). Real buttons with
  `focus-visible:ring-2`.
- **UX-110: Raw internals.** `panels/OperatorDashboardPanel.vue:360-363` renders raw
  `gateKind`/`helperKind` enums as the gate table's labels (the same file maps
  failure kinds through a key map two lines up) and `:168-171` renders the store's
  raw `e.message` as the error state's ONLY copy; `tasks/BugHuntModal.vue:507-509`
  prints the raw `provider:model` ref where `models.labelForRef()` exists for
  exactly this; `settings/McpOAuthCallbackScreen.vue:81` interpolates the internal
  `serverId` into the success headline; `initiative/InitiativeTrackerWindow.vue:448-453,599`
  shows planner item ids as dependency/deviation references instead of resolving
  them to titles; `panels/ReportsPanel.vue:73-76` falls back to the run UUID as a
  spend row's primary label.
- **UX-111: Stragglers.** `settings/CloudflareHandlerSection.vue:215-217` is the last
  bare `<UInput type="password">` in the tree (21 files use `SecretInput`);
  `bootstrap/BootstrapModal.vue:248-252` is the last hand-built raw-prose error
  toast (route through `present()`); `pipeline/PipelineBuilder.vue:1265` hides the
  per-pipeline default/archive/delete controls behind `opacity-0 group-hover` with
  no focus reveal (the UX-42 classes fix it).

---

## Verified good patterns (preserve these; copy them when fixing)

- Optimistic mutations in `stores/board.ts` snapshot and roll back with toasts;
  `updateBlock:363-372` even re-resolves so a mid-flight live event isn't clobbered.
- `components/board/AgentFailureCard.vue`: first-class retry with in-flight guard
  on every failed run/bootstrap.
- `composables/useFocusTrap.ts`: proper trap, focus-on-open, restore-on-close;
  `media/ArtifactLightbox.vue:157-171` is an exemplary dialog (role, aria-modal,
  dynamic label, Esc, alt text). `layout/SideBar.vue:134-145` uses `inert`.
- `layout/ConnectionStatusBanner.vue:59-64`: `role="status"` + `aria-live`.
- `panels/StepContainerStatus.vue:70`: the clipboard-with-toast pattern to reuse;
  `:120-121`: the title+aria-label icon-button pattern to reuse.
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

The 2026-07 P1 batch is done except UX-45. As of the 2026-08-18 re-audit:

1. **P1 batch (data loss / blocked flows).** UX-78, UX-79, UX-80, UX-93 and UX-94 are
   done, and UX-82 rode along with them. Still open: UX-81 (initiative-modal draft loss),
   UX-86/89 (wizard Done and foundational tab draft loss), plus the long-standing UX-45.
   UX-81/86/89 are the same defect as UX-79 on surfaces that are not result windows, so
   they take `useUnsavedGuard` the same way (UX-89 is the narrower
   `:unmount-on-hide="false"` fix); the guard spec added for UX-79 does not reach them,
   which is the gap to close when they land.
2. **Adoption sweeps with an enforcement hook** (UX-106..UX-109, UX-95..UX-98):
   each is one primitive applied across N call sites; land the sweep with a lint
   rule or guard where one is cheap, or the count regrows (theme 8).
3. **Failure-as-absence store sweep** (UX-91, UX-100..UX-105): the UX-75
   error-with-Retry shape, one PR over the listed stores.
4. **P2/P3 polish** opportunistically when touching the files anyway (per the i18n
   "lift copy when you touch a component" convention).

## Conventions & gotchas carried between iterations

- **An unsubmitted draft gets a FLUSH or a CONFIRM, and which one is decided by what the
  submit button does, never by convenience.** Flush (`useResultView({ onClose })`) is only
  correct when recording the draft decides nothing else: the review windows and the doc
  interview each persist one answer at a time, so writing on the way out is what the user
  meant. Everywhere else the only button carrying the draft also resolves a gate, spends a
  bounded chat turn, keeps an artifact or re-runs an agent, and a stray Escape may not do
  that on someone's behalf: those take `useUnsavedGuard` in front of the close. Two traps.
  A flush must capture the ids it needs SYNCHRONOUSLY (`blockId` and the derived state go
  null the instant the view tears down, so an awaited loop reading them writes nowhere),
  and it must report its own failure, because a close-time flush is the one path with no
  button left on screen to have reported it. A guard's `snapshot()` must exclude a draft
  that is no longer submittable (an alias on an unticked candidate, an answer to an item
  decided elsewhere), or it prompts over work that was going nowhere anyway.
- **A draft two components below the window that owns closing reports UPWARD.** The
  initiative plan review holds anchored comments and feedback inside a child of a child;
  it emits `update:dirty` and RETRACTS it on unmount, so a gate that resolves cannot leave
  the host prompting over a field that no longer exists.
- **The adoption guard has to assert the INVERSE too, and the inverse has to be widER than
  the shape you just fixed.** A table naming each surface's disposition rots into a list of
  what someone once believed unless something fails when a surface declared draft-free grows
  an input. The first version of that assertion (in `ResultWindowDrafts.logic.spec.ts`)
  greped for a textarea, which is what the windows it had just fixed happened to use, and
  it therefore could not see `v-model:answer="drafts[q.key]"` on a shared clarification
  component or a `:model-value` pair on a per-row `UInput`. It now flags ANY state binding
  or native control in a draft-free window, against a two-entry allow-list of view state
  (the lightbox's `open`/`index`) that has to be extended by NAME, so a new binding is
  unclassified until someone classifies it. Widening it found a fourteenth draft-holding
  window immediately. The positive half matters as much: assert that the window is wired to
  the seam its disposition NAMES, since "the close binding is not the literal `close`"
  passes a window that renamed its handler and still closes straight through.
- **A promise-based dialog is not exempt from the overlay STACK.** The shared confirm is a
  Nuxt UI modal, so it never registered on the app's one `sharedOverlayStack`, so
  `useModalBehavior` (which every result window's shell uses) still believed IT was topmost
  and swallowed the Escape meant for the confirm: the shell preventDefault-ed and re-entered
  its own close request, which supersedes the prompt the user was trying to cancel. It now
  pushes a ticket for as long as it is up. The other half of that bug was in the dialog
  itself: it is CONTROLLED, so a dismissal that settled the promise without writing `open`
  left a visible modal behind with no resolver, whose buttons then resolved nothing.
- **A guard's snapshot has to be exactly what the submit button WOULD send.** Over-broad and
  under-broad both fail, quietly and in opposite directions. Over-broad prompts to discard
  work that was already committed (a fork decision whose drafts were never cleared on
  success) or that could never be sent (a per-view note whose view a recapture removed), and
  each false alarm teaches the reader to dismiss the prompt. Under-broad is the original bug
  again: the tracker's snapshot reported only the plan review and let Escape eat the two edit
  forms in its own body. Deriving the snapshot from the send path (`buildFindings()`) is the
  version that cannot drift; where that is not possible, an inline form measures its
  DIVERGENCE from what it was SEEDED with, so an opened-but-untouched form is not "unsaved".
- **A pending confirm has to lock the surface that raised it.** `useConfirm` is a singleton
  and a new request supersedes the old one, settling it `false`, so any screen with two
  buttons that both confirm can silently cancel the first prompt with the second click. The
  lock is separate state from "work in flight": a row must not spin while its human reads the
  prompt, but every OTHER control has to be shut, and the entry guard on the handler is the
  authoritative half since it holds for callers the template doesn't know about. The mirror
  image is a surface that gates the wrong exits: the friction dialog disabled its "go review"
  escape hatch during a create while leaving Escape, the backdrop and Close live, so the safe
  action was blocked and the one that hides the outcome was not.
- **Undo pattern = deferred destructive action, not client-only rollback.** A "real"
  undo can't just `reattach` the client cache after a successful server delete: a coarse
  `board` refresh (`useWorkspaceStream` → `workspace.refresh()`) would re-fetch the block
  (still present server-side) and resurrect it. The working pattern (see `board.ts`
  `removeBlock`): **defer** the backend mutation by `UNDO_WINDOW_MS`, hide the subtree
  optimistically, and keep it filtered out of `hydrate`/`upsert` via a `pendingDoomed` set
  until the window elapses; the undo toast action just cancels the timer + restores. Capture
  the workspace id at call time so the deferred call targets the right board after a switch.
  A reversible (non-destructive) action like reparent doesn't need deferral: just offer an
  "Undo" toast that performs the inverse move (mark the inverse non-undoable to avoid a
  ping-pong toast).
- The shared undo toast shape: `color: 'neutral'`, `duration: UNDO_WINDOW_MS`, a single
  `actions: [{ label: t('common.undo'), icon: 'i-lucide-undo-2', onClick }]`. Reuse it for
  the remaining undo items (UX-52 high-blast-radius disconnects).
- **Clipboard copies go through `useCopyToClipboard()` (never `navigator.clipboard` raw).**
  The composable (`composables/useCopyToClipboard.ts`) wraps VueUse's `useClipboard` and always
  toasts the outcome, only claiming success once the write landed, so an insecure context /
  denied permission surfaces as a failure toast instead of a silent no-op. For a plain
  copy-icon affordance use the shared `common/CopyButton.vue` (it carries both `title` and
  `aria-label`); for a copy folded into a bespoke button, destructure `{ copy }` from the
  composable. Default label is `common.copy`, so no new i18n keys are needed for a generic
  copy button.
- **Agent prose renders through `MarkdownProse` (never raw `whitespace-pre-wrap`).** For any
  result-view surface that shows an agent's prose output (a rationale, a synthesis, a summary),
  use the shared `common/MarkdownProse.vue` (backed by `renderMarkdown()` in
  `utils/agentOutput.ts`: secure markdown-it, `html:false`, links opened safely), not a
  plain-text `<pre>`/`<p whitespace-pre-wrap>`. It's the inline counterpart to the full
  segmented reader (`parseOutputOutline`) used by `AgentStepDetail`. Pair copy-able output
  (JSON, prose) with the shared `common/CopyButton.vue`. A prose value that trails a label or a
  score inside the SAME line (`{{ score }} — {{ feedback }}`) is the same defect one step
  earlier: give it its own block, or a multi-point review renders as one run of text. A label that
  used to prefix such a value inline (`Summary:`) becomes a `block` heading line when the value
  becomes a block, or it reads as a stray word above a paragraph.
- **The reader is for PROSE; a VALUE stays preformatted.** Markdown is lossy in exactly the way a
  value cannot afford: `typographer` curls the quotes in a command, `__dunder__` in a path becomes
  bold, and leading indentation collapses (a single `\n` still breaks the line, so quoted output
  keeps one line per line). So a field a human COPIES — `prReview.suggestedFix`, a gate's
  `lastFailureSummary` — keeps `whitespace-pre-wrap`, while a field the agent WROTE as prose (a
  summary, a finding's detail, an assessment) goes through the reader. When prose has to carry
  something verbatim, the model fences it and the reader renders the fence.
- **A review VERDICT needs the prompt half too: rendering markdown cannot invent structure the
  model never wrote.** The companions carry `REVIEW_FINDINGS_LAYOUT` (`@cat-factory/agents`,
  `prompts/shared.ts`), which asks for one severity-graded `comments` entry per point and keeps
  the `summary` a short verdict that does not restate them. It replaced a layout asking for
  `**Must fix**` / `**Should fix**` / `**Minor**` bullet groups INSIDE the summary: the right
  grouping in a channel only a human reads, so the engine saw a must-fix and a nit as the same
  thing. Adding a reviewer of that kind means appending the fragment (pinned by
  `prompts/review-findings.test.ts`, override path included); one that already reports graded
  findings of its own (every judge, `pr-reviewer`, the tester) is deliberately EXCLUDED and needs
  only the render half. Kernel's `extractJson` repairs the raw line breaks a multi-line summary
  invites, so the contract cannot cost a verdict to a quoting slip — but only as a SECOND pass,
  after every candidate has been read as written, or a repaired example shape shadows the real
  verdict.
- **Content-heavy `UModal`s guard against discarding typed input via `useUnsavedGuard`
  (never a bare store-close on dismiss).** A controlled `UModal` whose `open` is a
  store-backed writable computed routes its dismiss paths (the setter's `if (!v) …`, and any
  Cancel button) through the composable's `requestClose()` instead of the store close action.
  The guard snapshots the form's user-owned state each time the modal opens (register it AFTER
  the component's reset watcher, and, because it reads the baseline synchronously, AFTER the
  refs the `snapshot()` closes over are declared, or it hits a TDZ), then prompts
  (`common.discard.*`) only when the current snapshot diverges. Keep `snapshot()` to stable
  user-owned values: exclude fields a background fetch rewrites (compare a stable id/key, not
  an async-resolved body) and skip cheap toggles that aren't real "work". An unchanged form, or
  a submit in flight (`saving`), closes immediately: the common path is unchanged. This is the
  `UModal` counterpart to UX-33's `useResultView.onClose` draft flush, and the same seam should
  carry the settings-panel variant (UX-53).
- **Flush unsaved draft input on the close path via `useResultView`'s `onClose` hook**
  (not per-close-button handlers). A result-view window that holds editable draft state
  (the review windows) passes `onClose: () => void flushDrafts()`; the composable fires it
  on the X button, the backdrop click, AND the Escape key, so no close path can leak. The
  flush MUST snapshot whatever it needs (the review, the block id) synchronously up front:
  the reactive `blockId`/derived state go null the moment `closeResultView()` runs, so an
  async persist that re-reads them mid-flight silently no-ops.
- **A best-effort async load that can fail must NOT swallow the error into an empty/idle state.**
  A store's `catch {}` that sets nothing renders as "nothing here": indistinguishable from
  genuine emptiness (the `loadContext` → `noContext` trap, UX-75). Record a per-key error message
  (`contextErrors`/`requestError`/`errors` shaped `Record<id, string | null>`), render a distinct
  error state, and offer a Retry that re-invokes the same loader (reuse `common.retry`, no new
  key). For a poll loop, a transient tick failure should keep polling up to a small cap (self-heal)
  then surface the error and stop, never wedge a spinner forever (UX-73).
- **Realtime resync/refresh retries; it does not fire-and-forget.** A coarse `workspace.refresh()`
  driven by a `board` event or a socket (re)connect goes through a bounded retry-with-backoff
  helper (`refreshWithRetry` in `useWorkspaceStream`) that aborts if the stream stopped or the
  workspace switched: one transient failure must not leave the board silently stale. `connected`
  is still announced even if every retry fails (we ARE connected; the resync is a best-effort
  reconcile, and wedging the indicator would break the e2e `data-connected` gate).
- **Action-bearing error toasts are sticky (`duration: 0`).** A toast whose value is a one-click
  remedy button ("Configure AI") must not auto-dismiss and take the remedy with it. Plain
  informational error toasts keep the default duration.
- **Icon-only buttons go through `common/IconButton.vue` (never a bare `<UButton icon=…>`).**
  The primitive requires a `label` and applies it as BOTH `:title` and `:aria-label`, so a
  named-icon button is correct by construction (the app has no `UTooltip`; `title`+`aria-label`
  is the pattern). It forwards all other UButton props/listeners via `$attrs`; `label` is a
  declared prop so it strips off before reaching UButton's own visible-text `label`. For a
  close/dismiss button use `:label="t('common.close')"` (the key already exists, no locale
  churn). A clickable non-`<button>` element (a `<div @click>`) is the same defect for the
  keyboard: make it a real `<button type="button">` with a `focus-visible:ring`. Hand-rolled
  inputs that only swap the border hue on focus need `focus-visible:ring-2` too (hue-only fails
  WCAG 2.4.7). Decorative infinite CSS animations must be silenced under
  `@media (prefers-reduced-motion: reduce)`, but leave `animate-spin` loaders alone, their
  motion is their meaning.
- **Secret/password fields go through `common/SecretInput.vue` (never a bare
  `<UInput type="password">` or a plaintext secret `<UTextarea>`).** The primitive masks by
  default and adds a trailing eye toggle (labeled `common.reveal`/`common.hide`,
  `aria-pressed`), forwarding every other UInput prop/listener via `$attrs`. Bind it with
  `v-model` exactly like `UInput`. For descriptor-driven fields whose secrecy is data-dependent
  pass `:secret="!!field.secret"` (falsy → a plain unmasked text input, no toggle): do NOT rely
  on the `secret` default of `true`, which would mask a non-secret field. A single-line masked
  input is the right shape even for long tokens (the four UX-20 `UTextarea`s were single-line
  vendor keys); reserve a real `UTextarea` for genuinely multi-line secrets (e.g. a PEM key),
  which this primitive does not cover.
- **A running step's elapsed clock comes from `useStepTimer`'s pure helpers, not a bespoke
  timer.** `stepDurationMs`/`stepDurationLabel`/`stepIsRunning` + a shared `useNowTick()` (all
  in `composables/useStepTimer.ts`) encode the one freeze rule: a step's clock stops at its
  finish, else the run's failure time, else the human-park (`pausedAt`), else it counts up to
  `now`. A list surface (the pipeline timeline, the inspector run list) drives every row's clock
  from ONE `useNowTick()` tick + the pure `stepDurationLabel(step, now, runFailed, failureAt)`;
  a single-step overlay keeps using the `useStepTimer({...})` computed wrapper. Do NOT hand-roll
  a second interval or re-derive the freeze logic.
- **Guard a destructive action in the SHARED primitive, not per call-site, when one exists.**
  Stopping a run (kill the container) is confirm-gated inside `board/AgentStopButton.vue` itself
  (via `useConfirm()`), so every surface that mounts it (board card + inspector bootstrap stop)
  inherits the confirm at once, mirroring how the board delete/undo path lives in `stores/board.ts`.
  Reach for the shared component before sprinkling `confirm()` at each usage. The one stop surface
  that does NOT mount that primitive: the inspector's live task-execution stop
  (`TaskExecution.vue` calls `execution.stop()`, not `agentRuns.stop()`): is confirm-gated at its
  own call site reusing the SAME `board.stop.confirm.*` keys, so a run's stop is confirmed
  identically no matter which surface it is triggered from.
- **A disabled control must say WHY, and a native `title` on a disabled element is not
  enough.** A disabled `<button>`/`<UButton>` doesn't fire hover, so its `title` tooltip never
  shows: pair the title with a visible hint line (see UX-40's `runBlocked` reason, rendered
  both as `:title` and as an amber line with a `data-testid`) so pointer, keyboard, and touch
  users all get the reason. Derive the reason from the SAME predicate that disables the control
  (here `board.unmetDeps` ⇄ `isRunnable`) so the two can't drift.
- **Reveal a hover-only affordance on keyboard focus too.** An `opacity-0
group-hover:opacity-100` control is invisible to keyboard/touch; add
  `group-focus-within:opacity-100` (tabbing into the containing row) and `focus-visible:opacity-100`
  (the control itself focused) so it isn't a pointer-only gesture (UX-42).
- **Per-item async feedback comes from per-key in-flight tracking, not a shared store
  `loading` flag, for any LIST of actionable rows.** A single `store.loading` bound to every
  row's button spins them all at once and cross-spins sibling forms (UX-29). Track a
  `reactive(new Set<string>())` of keyed ids (`<action>:<rowId>`) and wrap each row action in a
  `withRow(key, fn)` helper that adds/removes the key in a `try/finally`; bind `:loading` to
  `set.has(key)`. Give each distinct form-submit its OWN local `ref` so it can't inherit an
  unrelated action's spinner. (Same "one control, one signal" idea as the elapsed-clock and
  disabled-reason conventions.)
- **A list of editable rows keys `v-model` by a client-only stable `uid`, never the array
  index.** Deleting/reordering a middle row with `:key="i"` silently rebinds a neighbour's
  inputs (UX-23). Stamp each row a `uid` on load/add (a module `let seq = 0; nextUid()` counter:
  do NOT reach for `Math.random`), key by it, delete by it, and re-stamp on save-reload. Pair
  with a save-time integrity check: a half-filled row (some but not all required fields) BLOCKS
  the save with a warning toast rather than being silently dropped; a fully-empty row is an
  unused slot and is ignored.
- **A destructive list-row action gets the same `useConfirm()` gate its siblings have.** An
  `unlink`/`remove`/`disconnect` that removes real state (a synced fragment source and its
  fragments: UX-21) must route through `useConfirm({ variant: 'destructive', … })` naming the
  target, mirroring the nearest already-confirmed sibling in the same component (`removeFragment`).
- **A button that triggers a full-page navigation still needs a pending state.** `SlackPanel`'s
  OAuth button sets a `connectingOAuth` ref before `await`ing the redirect URL and clears it ONLY
  on the error path: the success path unloads the page, so there is nothing to reset (UX-30).
- **A drag-to-resize grip straddles the border it moves; it never sits inside the content.**
  A grip parked on an inner element's edge (the frame's drop zone) renders as a scrollbar and
  is invisible as an affordance, however wide the hit area is (UX-17). Anchor it to the box
  whose border the user sees, offset it by half its width so the band is centred ON that border,
  and keep the DRAWN affordance thin (a 2px bar) so a generous hit target doesn't become a fat
  visible stripe. Light that bar from component state, not a `hover:`/`group-hover:` utility:
  the bar is a child of the hit band, and the same predicate then covers the drag, where it
  must follow the GRABBED edge, since the pointer leaves a 12px band constantly. A pointer drag
  that tracks past its handle holds its cursor on `<body>` for the duration and restores on
  `pointercancel` too, not only `pointerup`. **Offer every border, not the two that are cheap to
  implement**: users read a missing handle as a broken one, and on parent-relative coordinates the
  cost of the other two is a single arithmetic UPDATE that translates the children (plus the
  matching optimistic shift + rollback in the store), not a per-child write.
- **A frame-level tally that the cards below already answer is noise, not a summary.** The
  service frame's "N/M implemented" line was removed: every task card carries its own status,
  so the frame-level count restated it more coarsely and over the wrong denominator (every task
  ever added, not the work in flight). What belongs on a container's meta line is what its
  contents can't show at a glance (module count, PR-ready count).
- When fixing i18n papercuts (UX-13), remember the locale-parity CI check: adding,
  changing, OR removing an `en.json` key requires the same change in every other locale in
  the same PR (removing the two dead `clarity.*` keys above meant editing all 8 locales).
- Frontend fixes to `@cat-factory/app` need a changeset (patch), and any new
  interactive affordance covered by e2e wants a `data-testid`.
- **`UTabs` unmounts hidden tab panels by default** (@nuxt/ui `unmountOnHide: true`),
  so any tab panel holding local form/draft state loses it on a tab switch. Pass
  `:unmount-on-hide="false"` or lift the draft into a store (UX-89).
- **An availability probe splits SETTLED refusals from TRANSIENT failures.** Only a
  503 (capability unwired) may set `available = false`; any other error is recorded
  as a load error with a Retry, or the copy blames the operator's configuration for
  an outage (UX-91). The `capabilityCredentials`/`toolServers`/`publicApiKeys`
  stores are the in-tree pattern.
- Line references in sections A-F are from the 2026-07-02 audit (partially refreshed
  2026-08-18), in sections G-K from 2026-08-18; re-verify anchors before editing.
- Findings marked as corroborated by two independent audit passes: UX-13, UX-25,
  UX-19/20 (secrets), UX-01 (delete/undo).
