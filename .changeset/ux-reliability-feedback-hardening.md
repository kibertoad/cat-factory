---
'@cat-factory/app': patch
---

UX reliability & feedback hardening: inspector edits (title/description/run settings) now roll
back and toast on a failed save instead of silently sticking a stale value; notification
act/dismiss failures surface an error toast; the `Delete` key can no longer delete a block hidden
behind an open result-view window (those windows now carry `role="dialog"`); merging a PR and
discarding a run are gated behind a confirm; an emptied task title reverts to its last saved
value; a "Reconnecting…" indicator shows when the live event stream drops; and the remaining
hardcoded app-shell / toast / bootstrap strings are routed through i18n.
