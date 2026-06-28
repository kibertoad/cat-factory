---
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Allow the `X-Connection-Id` request header in CORS so the SPA can reach the backend.

The SPA sends `X-Connection-Id` on every API call (the per-tab connection id for real-time
self-echo suppression), but the Worker's CORS preflight only allow-listed
`Content-Type, Authorization, X-Personal-Password`. The browser's preflight asked permission
for `x-connection-id`, the response omitted it, so the browser dropped every cross-origin
request with "CORS Missing Allow Header" and the board failed to load ("Can't reach the
backend"). curl/server-side callers were unaffected because they don't send the header.

Move the allow-list to a single shared `CORS_ALLOWED_HEADERS` constant in
`@cat-factory/server` (now including `X-Connection-Id`) and use it in both runtime facades.
The Node facade previously passed no `allowHeaders` and so let Hono echo the requested
headers, which silently masked the drift; it now uses the same explicit list as the Worker.
