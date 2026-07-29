---
'@cat-factory/app': patch
---

Float still-unanswered questions to the top of the initiative planning window. A multi-round
interview keeps the answered/dismissed digest and appends each new round after it, so from round
two the questions the human could still act on sat below everything they had already settled. The
render order is now pending-first (chronological within each group), re-snapshotted per round so
answering one doesn't reshuffle the list. The stored `qa` order — which the interviewer prompt and
the in-repo tracker digest read — is unchanged.
