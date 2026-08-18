---
'@cat-factory/app': patch
---

Cut what the board measures per frame and what the SPA loads before first paint.

The canvas activity pulse now separates the signals a user is watching (pointer, wheel, scroll,
resize, camera) from render-driven mutations, which are rate-limited, so a board taking a steady
stream of execution events lets its two DOM-measuring loops park instead of holding them awake
continuously. Each pass also resolves and measures every card through one shared snapshot rather
than a `querySelector` plus a `getBoundingClientRect` per link.

The built-in result windows are contributed as async components and the step-detail reader mounts
only while a step is open, taking 281 kB off the eager bundle (2.14 MB to 1.86 MB); both load on
the click that needs them. Every code-split surface now goes through one `defineAsyncView` seam
that renders a stated failure when its chunk cannot be fetched, so a deploy landing under an open
tab no longer turns the next click into a blank screen.
