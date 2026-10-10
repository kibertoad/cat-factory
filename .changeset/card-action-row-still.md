---
'@cat-factory/app': patch
---

A task card's action buttons no longer move when the pointer arrives on them. Hovering a card with
a run expands its pipeline steps, and the steps rendered above the action row, so the expansion
pushed Resolve, Approve and Outcome down mid-click: the first click selected the task instead of
acting. The steps now render below the action row.
