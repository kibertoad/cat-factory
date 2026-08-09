---
'@cat-factory/app': patch
---

Stop the board's two DOM-measuring drivers from running every animation frame while nothing is
moving. The dependency-edge overlay and the task-expansion driver now wake on a canvas activity
pulse and park once their output settles, and the overlay publishes a segment list only when it
actually moved. An idle board schedules no frames at all.
