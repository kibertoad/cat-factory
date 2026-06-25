---
'@cat-factory/app': patch
---

Fix the flashing pipeline on a task stacked above another when zoomed in.

The board's expansion driver tested overlap with each card's live rect, which
collapses the moment a card is denied. A top task directly above another would
no longer overlap once collapsed, get re-granted, expand, overlap again, and get
denied — flashing its pipeline every frame. The driver now caches each card's
expanded height while it's granted and projects the footprint with it, so a
denied card is still tested at its expanded extent and stays compact.
