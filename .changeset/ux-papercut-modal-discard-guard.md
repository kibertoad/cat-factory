---
'@cat-factory/app': patch
---

UX papercuts: guard content-heavy modals against silently discarding typed input, and make
the decision modal safe against double-submit (initiative `ux-papercuts.md`, UX-18 + UX-25).

**Discard guard (UX-18).** A new shared `useUnsavedGuard` composable routes a modal's
dismiss paths (Escape, backdrop click, Cancel) through a dirty check: when the form diverges
from the state it opened with, the user is asked to confirm before losing their input; an
unchanged form (or a submit in flight) closes immediately as before. Wired into
`AddTaskModal`, `RecurringPipelineModal`, and `BootstrapModal` — the three modals that
previously wiped every field on an accidental Escape/backdrop close.

**Decision modal double-submit (UX-25).** `DecisionModal` now awaits `resolveDecision`,
disables all options while one is resolving (with a spinner on the chosen option), and keeps
the modal open with an error toast on failure instead of closing silently — a fast
double-click can no longer dispatch two resolutions.
