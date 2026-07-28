---
'@cat-factory/app': minor
---

Show the tracker being searched whenever a context issue is attached to a task, and let a tracker be
added from the same place. The context-issue picker's source selector used to appear only once a
second tracker was offered, so a single-tracker workspace never saw which tracker a pasted issue key
would resolve against; it is now always rendered, and its menu carries the not-yet-offered trackers
as connect/enable entries that open the connect modal over the caller's form. A tracker connected
that way becomes the picker's selection as soon as it is offered.
