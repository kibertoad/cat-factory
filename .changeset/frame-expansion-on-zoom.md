---
'@cat-factory/app': patch
---

Board: gate zoom-driven service-frame expansion to on-screen, centre-most frames.
Previously every frame expanded at once past the `close` zoom band, so a large
off-centre service would snap out over the smaller one the user was focused on,
and services that weren't on screen expanded too. A new frame-expansion driver
(the frame-level analogue of the existing task-expansion gate) only opens frames
that overlap the viewport, preferring the one nearest the screen centre when two
expanded footprints would collide.
