---
'@cat-factory/app': minor
---

Add a queue view beside the board (issue #2258). The queue lists every task across every service in the column that says what it needs (Needs you, In flight, Ready to merge), and each card carries the one action its state implies. The sidebar's new Views switcher, the palette and a `?view=queue` link move between the queue and the canvas. The SPA opens on the view each person used last; a person who has not chosen lands on the queue. The canvas's decision counter now opens the queue view instead of a dropdown. The board card and the frame swimlanes share their action and classification code with the queue (`useTaskActions`, `useTaskLaneClassifier`).
