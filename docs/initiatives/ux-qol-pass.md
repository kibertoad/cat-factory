# UX quality-of-life pass

## Goal & rationale

Eliminate a cluster of everyday interaction papercuts in the SPA (`@cat-factory/app`,
`frontend/app`). Three surfaced from a review of the frontend, all confirmed against code:

1. **Destructive actions fire instantly, no confirmation** — deleting a task/service/module,
   a pipeline, a merge/model preset, or a dependency edge mutates immediately (optimistic
   rollback exists, but there is no "are you sure?").
2. **Actions succeed silently** — starting a run, acting on/dismissing a notification, saving
   settings, copying a container id/url give no feedback.
3. **Keyboard support stops at ⌘K** — no Escape to deselect, no Delete to remove a selected
   block, no discoverable cheatsheet.
4. **Empty states are hand-coded and missing** — no reusable primitive; several surfaces
   render blank.

Delivered as a **two-PR initiative** because the items have a real dependency edge, not just
size: keyboard-delete (PR 2) must route through the **same** confirm-gated deletion the button
uses (PR 1), or the two delete paths drift and only one is safe. PR 1 lands the reusable
primitives + the highest-risk safety fix; PR 2 builds feedback + keyboard on top. Each PR is
independently shippable and reversible.

## Target pattern (reference implementations)

Once PR 1 lands, reuse these rather than reinventing:

- **Confirm-then-mutate**: `frontend/app/app/composables/useConfirm.ts` +
  `frontend/app/app/components/common/ConfirmDialog.vue`. Call `await confirm({ variant:
'destructive', title, description })` and bail on `false` **before** any mutation. One
  always-mounted dialog + a module-level singleton queue; dismiss (backdrop/Escape) resolves
  `false`.
- **Shared block deletion**: `frontend/app/app/composables/useBlockDeletion.ts` — the single
  confirm-gated block delete used by both the inspector button and the keyboard shortcut.
- **Empty surfaces**: `frontend/app/app/components/common/EmptyState.vue` —
  `<EmptyState :icon :title :description>` with an optional action slot.

Conventions the primitives follow: `UModal` (`v-model:open`, `#body`/`#footer`), `UButton`,
`UKbd`, `useI18n().t(...)`, dark-slate styling. All copy in `frontend/app/i18n/locales/en.json`.

## Status checklist

### PR 1 — Primitives + destructive safety + empty states

| Unit                                                                                                                                                    | Status | PR   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| Tracker document                                                                                                                                        | done   | PR 1 |
| `useConfirm.ts` + `ConfirmDialog.vue` + mount in `index.vue`                                                                                            | done   | PR 1 |
| `useBlockDeletion.ts`                                                                                                                                   | done   | PR 1 |
| Confirm: delete task/module/service/recurring (`InspectorPanel`)                                                                                        | done   | PR 1 |
| Confirm: delete pipeline (`PipelineBuilder`)                                                                                                            | done   | PR 1 |
| Confirm: delete merge preset (`MergeThresholdsPanel`)                                                                                                   | done   | PR 1 |
| Confirm: delete model preset (`ModelConfigurationPanel`)                                                                                                | done   | PR 1 |
| Confirm: remove dependency edge (`TaskDependencies`)                                                                                                    | done   | PR 1 |
| `EmptyState.vue`                                                                                                                                        | done   | PR 1 |
| EmptyState: context pickers, dependencies, execution history (preset panels skipped — a default preset always exists, so the empty case is unreachable) | done   | PR 1 |
| `data-testid`s for e2e (confirm-dialog/accept/cancel, empty-state, inspector-delete)                                                                    | done   | PR 1 |
| i18n keys (8 locales) + patch changeset                                                                                                                 | done   | PR 1 |

### PR 2 — Feedback toasts + keyboard shortcuts + help

| Unit                                                                | Status | PR   |
| ------------------------------------------------------------------- | ------ | ---- |
| Toast: run started (`TaskCard`)                                     | done   | PR 2 |
| Toast: notification acted/dismissed (`NotificationsInbox`)          | done   | PR 2 |
| Toast: settings saved (`WorkspaceSettingsPanel` already toasts; `TaskRunSettings` skipped — inline auto-save, a toast per field-change is noise) | done | PR 2 |
| Copyable container id/url + toast (`StepContainerStatus`)           | done   | PR 2 |
| `useKeyboardShortcuts.ts` (Escape / Delete / ?)                     | done   | PR 2 |
| `KeyboardShortcutsHelp.vue` + `ui.shortcutsHelpOpen`                | done   | PR 2 |
| Command-bar "Keyboard shortcuts" entry                              | done   | PR 2 |
| i18n keys (8 locales) + patch changeset                             | done   | PR 2 |

## Conventions & gotchas (carried between iterations)

- **`UModal` already traps focus + closes on Escape + renders a backdrop.** Never add
  `useFocusTrap` or a manual Escape bind on a UModal surface — it double-binds and fights the
  modal. `useFocusTrap.ts` is for non-UModal surfaces only.
- **The confirm singleton must resolve `false`** on backdrop/Escape/route-change dismiss and
  when superseded by a newer `confirm()` call — otherwise the awaiting promise hangs forever.
- **Delete-while-typing guard is mandatory** — the global Delete/Backspace handler must bail
  when the event target is an `<input>`, `<textarea>`, `[contenteditable]`, or inside one.
- **Escape-vs-modal guard** — the global Escape (deselect) handler must bail when a modal is
  open. Use a DOM check (`document.querySelector('[role="dialog"]')`, every modal is a
  `UModal`) rather than enumerating the ~25 `*Open` flags in `stores/ui.ts`.
- **Only toast on confirmed success** — e.g. `TaskCard.run()` toasts only when
  `execution.start()` returns `true`; don't duplicate toasts a store already emits (the
  `execution.start` failure path and `AgentStopButton` already toast).
- **Confirmation is strictly before the optimistic mutation**, so `board.ts`'s
  `RemovalSnapshot` rollback semantics are unchanged.
- **Register the global keydown listener exactly once** (from `pages/index.vue` setup), never
  per-component, to avoid N handlers firing N deletions.
- **i18n**: straight quotes, no em-dashes; `@key` descriptions only for genuinely ambiguous
  keys; translated catalogs (`es/fr/…`) carry no `@` siblings.
  </content>
