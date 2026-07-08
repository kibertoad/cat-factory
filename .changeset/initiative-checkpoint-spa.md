---
'@cat-factory/app': patch
---

Initiative tracker: surface phase checkpoints in the SPA (slice 3 of the
custom-initiative-definitions initiative). A `checkpoint` phase now carries a visible
annotation in the tracker window's phase list — "awaiting review" on the phase whose
completed checkpoint is holding the initiative, "reviewed" once cleared, "checkpoint" for
an upcoming one — and, when the initiative is paused at a checkpoint, a banner explains the
wait (naming the phase) and offers Resume (continue) / Cancel (stop) inline, so the tracker
is the review surface a human acts from. The initiative board card also exposes its
lifecycle status as `data-status` for observability.

Purely additive UI over the existing paused/resume lifecycle + the `initiative` checkpoint
notification (both shipped in slice 2); no behaviour change for non-checkpoint initiatives.
