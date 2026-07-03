---
'@cat-factory/local-server': patch
---

Pin the local browsable-preview host port to the app's serve port so the preview origin is a deterministic `http://localhost:<servePort>` — the same origin `frontendOriginsForService` injects into a bound backend's CORS allow-list. Previously the preview published to an ephemeral host port and formed its URL via `docker port` (`http://127.0.0.1:<random>`), a different origin, so a developer browsing the preview was CORS-blocked when the app called the live backend. `RunContainerSpec.publishPorts` gains an optional pinned `host`, and a new `ContainerRuntimeAdapter.publishesToLocalhost` flag distinguishes the Docker family (pinnable localhost origin) from Apple `container` (reached at the container's own IP).
