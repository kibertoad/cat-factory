---
'@cat-factory/app': patch
---

Hovering a task card no longer expands its pipeline steps. The expansion moved the card's own
buttons and pushed the cards below it down, so the first click on Resolve, Approve or Outcome often
selected the task instead of acting. An in-flight card now shows the step its run is on, the step's
position and one segment per step in place of the progress bar, at every zoom. The full step list
is in the inspector, and on the card past the `steps` zoom band.
