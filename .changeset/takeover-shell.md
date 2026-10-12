---
'@cat-factory/app': patch
---

Render every full-bleed takeover inside one shared `TakeoverShell`, so focus stays inside an open takeover and Escape closes only the top overlay. The step reader, the model configuration takeover, the observability, reports, operator dashboard and Kaizen panels, and the artifact lightbox now use it. The safe-area guard also refuses a full-screen root class named outside its owning shell.
