---
'@cat-factory/app': patch
---

Infrastructure attempts window (run details) now live-tracks every container spin-up /
tear-down as it happens: while the run is active it silently re-polls so each attempt
appears with its timestamp, and it does one final poll on the terminal transition to catch
the last tear-down row. Once the run is no longer doing anything the refresh control and
its "refreshing" spinner are hidden — there is nothing left to refresh.
