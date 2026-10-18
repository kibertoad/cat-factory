---
'@cat-factory/app': patch
'@cat-factory/storybook': patch
---

The component stories answer API requests with msw's in-page fetch and XHR interceptors instead of
its service worker. The worker served every frame of the origin, so in the story test lane it
proxied the Vite modules of every stories file after the first, and random files failed to import
in CI. `mockServiceWorker.js` and the Storybook static directory that served it are gone.
