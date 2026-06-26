---
'@cat-factory/app': patch
---

Board: fix task-card expansion picking the wrong card, and stop task titles from being
cut off. The "centre-most task wins" expansion gate had regressed: ranking cards by
their distance to the projected footprint scored every footprint the screen centre fell
inside at 0 (a tall card bleeding its expanded extent down from above ties with the card
whose band actually holds the centre), so the tie broke by document order and a stacked
neighbour could expand instead of the card you were looking at. Ranking is now by centre
ownership — the card whose band holds the centre wins, and a card you've scrolled into
keeps its grant — extracted to a pure helper with unit tests so it can't silently
regress again.

Task titles now wrap to two lines instead of truncating to an unreadable stub (full text
still on hover), and task cards are a little wider to give titles more room.
