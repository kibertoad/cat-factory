---
'@cat-factory/app': patch
---

My setup now loads its rows when it opens, so the GitHub token, local runner and personal
subscription badges show what you have connected. Before, the modal mounted already open and its
load never ran, so each row showed only what another screen had loaded.

A row for one of these per-user connections, in My setup, the Model providers hub and the
Integrations hub, now says "Checking…" while its status loads and "Couldn't load" when the load
fails (a server error, an outage or no connection), instead of "Not connected". A signed-out
caller or a module the deployment has not configured still reads as nothing connected. The
notification routing panel now treats an outage 503 as a failed load too, where before any 503
read as "not configured".
