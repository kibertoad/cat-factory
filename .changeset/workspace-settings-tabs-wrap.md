---
'@cat-factory/app': patch
---

Workspace settings tabs no longer truncate or scroll. The tab strip now wraps onto a
second row when the viewport is too narrow to fit every label, keeps each tab at its full
content width (no more "Workspa…"/"Bud…" ellipsis), and drops the sliding indicator — which
couldn't track wrapped rows — for a per-tab active underline, removing the stray vertical
scrollbar.
