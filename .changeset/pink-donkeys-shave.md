---
'@cat-factory/app': minor
---

Add a tracker from the bug hunt. The hunt's tracker field is now the same two-tier menu the
context-issue picker uses: the trackers the workspace offers, then the ones it could add. Picking
one to add routes straight to that tracker's own connect screen instead of leaving the user to
find the Integrations hub, and the connect form opens over the hunt so the board scope, issue type
and labels already typed survive the detour. Once the tracker turns up offered it becomes the
hunt's selection automatically. A tracker that is connected but toggled off for the workspace is
offered as "enable" rather than "connect".
