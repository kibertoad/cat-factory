---
'@cat-factory/app': patch
---

Pin the SPA to dark mode so Nuxt UI's own chrome matches the board. The app is a
single dark-themed surface (neutral mapped to `slate`, everything hand-styled in
slate), but color mode was unpinned and followed the visitor's system preference,
so every Nuxt UI overlay and form control (modals, inputs, selects, dropdowns)
rendered light/white with washed-out text. Color mode is now pinned to dark, and
overlays (`UModal`/`USlideover`) get a shared layered dark palette via `app.config`
(a deep slate-950 surface with slate-800 chrome) matching the agent-run-details
reader.
