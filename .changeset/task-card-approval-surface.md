---
'@cat-factory/app': patch
---

Surface pending approval gates on board task cards, and stop the `blocked` status
from universally reading "Decision needed".

A task parked on a step's **approval gate** (`requiresApproval`) showed up on the
board as "Decision needed" with no badge and a click that did nothing — the task
card only ever handled agent-raised *decisions*, never approvals, so an
approval-gated run looked stuck with nothing to act on. (The frame badge,
inspector and focus view already surfaced it; only the task card was a dead end.)

`TaskCard.vue` now derives what a `blocked` task is actually waiting on — a
decision, an approval, or a terminal failure — and shows the matching label
("Decision needed" / "Approval needed" / "Failed"), an amber attention pulse, and
a **Resolve**/**Approve** action that opens the right modal (clicking the card
does the same). The generic `STATUS_META.blocked` label is now the neutral "Needs
attention" so no surface implies a decision when the run is really awaiting an
approval or has failed.
