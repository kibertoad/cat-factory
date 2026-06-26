---
'@cat-factory/app': patch
---

Board: services are now freely draggable and overlap is managed by hover. The whole
service header bar is the drag handle (previously only the title cluster moved the
frame, which read as undraggable), with the action buttons opting out so they still
click. Moving a service no longer shifts any other service: the render-time
auto-displacement that pushed expanded frames apart is removed, so frames render at
their stored position, can overlap freely, and the dragged one tracks the cursor 1:1.
The frame under the pointer (the un-obscured one) is lifted above overlapping
neighbours via its Vue Flow node z-index, and the dragged frame sits above everything,
so overlapping services can always be reached and reordered.
