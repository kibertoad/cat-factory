---
'@cat-factory/app': patch
---

Show a loading spinner on first SPA load via Nuxt's `spaLoadingTemplate`, so the very
first paint is a spinner on the dark board background instead of a blank white screen
while the JS bundle parses and Vue mounts.
