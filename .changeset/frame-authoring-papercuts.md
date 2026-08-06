---
'@cat-factory/app': patch
---

Show which document source the context picker searches, and stop asking a question the frame already answered

Board-authoring papercuts, all of them a control that says less than it looks like it says.

The context-document picker only rendered its source selector when the workspace had MORE than one
source connected, which is the case almost nobody is in: GitHub docs ride the installed App, so the
common workspace has exactly one and the selector was invisible. That hid the one fact the picker's
whole behaviour turns on, since the selected source decides what a pasted reference resolves to and
which repository a file pick browses, and it left no route to adding Confluence or Notion from the
place a missing source is actually discovered. The source is now always named, with the two-tier
menu the ISSUE picker has always had (pick a connected source, or connect one from here, the connect
modal opening over the caller's form so nothing typed is lost), and the helpers behind that menu
moved to a source-agnostic `utils/sourcePicker.ts` which now owns the rendering rule too rather than
leaving three copies of it. Where the menu has nothing to decide the source renders as a LABEL, not
a chevron: connecting is admin-tier while attaching is member-tier, so a member's menu holds one
entry that re-selects what is already selected. The no-source empty state follows the same split,
telling a member to ask an admin rather than to do what their own menu withholds. A document source
cannot be "connected but switched off here" the way a tracker can, and that is now unrepresentable
in the choice type instead of a convention a future toggle would quietly break.

"Create task from issue" exists only on a service frame's own header, so the frame settles WHICH
SERVICE; the modal asked for a container anyway, over every frame and module on the board. It now
narrows to that frame and its modules, and states the target outright when the frame has no modules,
since only then is there nothing left to decide. Frame-or-which-module is a question the header
button never answered, so scoping rather than pinning is what keeps a module reachable. The bug-hunt
modal is opened from the same header with the same payload and now shares one answer
(`useContainerTargets`) instead of a second copy that disagreed. The target is re-resolved through
the board on every read, so a frame deleted while either modal sits open widens back AND drops the
selection that pointed at it: a stale id renders as a picker with nothing selected while the issue
search under it stays scoped to the block that is gone.

The frame header's collapse chevron is gone, and so are the two branches it belonged to. Frames have
been unconditionally expanded for a while, which made the button a no-op that looked like the way
back from a state nothing could reach; the far-zoom chip and collapsed-summary branches it went with
were equally unreachable, and between them they held the only render of the "Shared" badge, which
now sits on the service card's title row where a service mounted on several boards can actually be
seen to be one. The expanded-frame set in the UI store went with them.
