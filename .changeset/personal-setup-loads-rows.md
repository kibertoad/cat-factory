---
'@cat-factory/app': patch
---

My setup now loads its rows when it opens, so the GitHub token, local runner and personal
subscription badges show what you have connected. Before, the modal mounted already open and its
load never ran, so each row showed only what another screen had loaded. When a row's status fails
to load (a server error or no connection), the row now says it could not load instead of "Not
connected". A signed-out caller or a module the deployment has not configured still reads as
nothing connected.
