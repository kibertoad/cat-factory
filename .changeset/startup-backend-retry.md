---
'@cat-factory/app': patch
---

Retry the cold-start backend fetch instead of flashing "Can't reach the backend". When the SPA and backend are started together, the first `getAuthConfig`/`listWorkspaces` call can beat the backend's listener; a status-less connection fault is now retried with exponential backoff up to a 15s deadline (the auth gate keeps its spinner), while a real HTTP error response still surfaces immediately.
