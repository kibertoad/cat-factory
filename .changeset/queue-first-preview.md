---
'@cat-factory/app': minor
---

Add the queue-first preview (issue #2258), off by default and switched on per browser with `?preview=queue` or the palette. While it is on, the home is a workspace-wide queue of tasks grouped by what they need, intake is one sentence plus a service, setup is one checklist page that replaces the setup banners and startup dialogs, and an inbox card carries its real verb. The board card and the frame swimlanes now share their action and classification code with the queue (`useTaskActions`, `useTaskLaneClassifier`); nothing changes for a browser that never switches the preview on.
