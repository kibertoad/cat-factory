---
'@cat-factory/app': patch
---

Show which document source the context picker searches, and stop asking a question the frame already answered

Three board-authoring papercuts, all of them a control that says less than it looks like it says.

The context-document picker only rendered its source selector when the workspace had MORE than
one source connected, which is the case almost nobody is in: GitHub docs ride the installed App,
so the common workspace has exactly one and the selector was invisible. That hid the one fact the
picker's whole behaviour turns on, since the selected source decides what a pasted reference
resolves to and which repository a file pick browses, and it left no route to adding Confluence or
Notion from the place a missing source is actually discovered. The selector is now always on
screen with the two-tier menu the ISSUE picker has always had (pick a connected source, or connect
one from here, the connect modal opening over the caller's form so nothing typed is lost), and the
tracker-side helpers behind that menu moved to a source-agnostic `utils/sourcePicker.ts` rather
than being copied. Its add tier is withheld from a member, who may attach a document but not store
a workspace credential.

"Create task from issue" exists only on a service frame's own header, so the frame IS the target;
the modal asked which container anyway, defaulting to the right answer. It now states the frame
instead, and keeps the container picker for the standalone tracker browser (command bar,
Integrations hub), which genuinely has no frame behind it. A frame deleted while the modal sits
open falls back to the picker rather than pinning a target nothing can be created in.

And the frame header's collapse chevron is gone. Frames have been unconditionally expanded for a
while (`showExpanded` is pinned true so the canvas layout is fixed under pan and zoom), which made
the button a no-op that looked like the way back from a state nothing could reach.
