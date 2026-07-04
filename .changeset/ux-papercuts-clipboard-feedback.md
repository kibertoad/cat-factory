---
'@cat-factory/app': patch
---

UX papercuts (docs/initiatives/ux-papercuts.md): clipboard-feedback shared primitive
(UX-38/39).

- New `useCopyToClipboard()` composable wraps VueUse's `useClipboard` and always toasts the
  outcome, only claiming success once the write actually landed — so a copy in an insecure
  context or with a denied permission surfaces a failure toast instead of a silent no-op.
- All previously-silent copy handlers now route through it: `StepMetadataCard`/`StepRunMeta`
  (run id), `AgentStepDetail` (raw output), `KubernetesEngineForm` (auto-setup command); the
  origin pattern in `StepContainerStatus` is refactored onto the composable.
- New reusable `common/CopyButton.vue` (title + aria-label) makes error/detail surfaces
  copyable: the failure stack-trace `<pre>` (`FailureDetail`, so both `AgentFailureCard` and
  `AgentFailureHistory`), the consensus failure banner, and the gate failure summary.
