---
'@cat-factory/app': patch
---

Make touch targets and overlays phone-friendly (phase 2 of the mobile-friendly work).
On a coarse pointer (phones/tablets) the board's small drag/resize affordances grow to a
comfortable tap size — the task drag grip, the service/module resize edges + corner, the
drag-to-connect handle, and the frame-header action buttons (`xs` → `sm`) — driven by the
`pointer: coarse` media query so precise-pointer (mouse) desktops are unaffected. The
hand-rolled overlay windows (requirements/clarity/spec/consensus/brainstorm review windows
plus the follow-up, test-report, visual-confirmation, gate, generic-structured and
human-test result views), the Pipeline builder, and the full-screen Model Configuration and
Agent Step Detail panels are now capped to the dynamic viewport (`dvh`) so their content and
controls — including the Agent Step Detail review rail's bottom-sheet gate buttons — stay
reachable above the mobile browser chrome instead of being clipped; the centred review
windows use `max-h-[90dvh]` (so they can't overflow unreachably on very short viewports) and
the Pipeline builder's three columns stack and scroll as one on compact viewports.
