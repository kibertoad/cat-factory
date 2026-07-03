---
'@cat-factory/app': patch
---

Board: a newly added service frame is placed clear of existing board nodes and the camera centres on it.

Adding a frame no longer drops it on top of a neighbour or leaves it off-screen. A new pure
helper (`findFreeFramePosition` in `utils/framePlacement.ts`) picks the nearest non-overlapping
top-left for a frame of a given size, and the `useFramePlacement` composable wires it to the live
board + Vue Flow camera (`focusFrame` pans, gently zooming in only if the board is zoomed far out).
The clearance considers every top-level board node — both service frames and epic grouping cards —
so a new frame never lands on top of an epic either.
Wired into all three add-a-frame paths:

- **Palette drop** (`BoardCanvas`): the frame lands where you drop it, nudged off any frame it
  would overlap, then centred.
- **Import from repo** (`AddServiceFromRepoModal`): the client now sends a computed free position
  instead of relying on the backend's fixed diagonal stagger, then centres on the import.
- **Bootstrap** (`BootstrapModal`): the provisional frame is re-homed to free space (the backend
  stagger can land on top of a large existing service) and centred.
