---
'@cat-factory/app': patch
---

Infrastructure attempts window (run details) now live-tracks every container spin-up /
tear-down as it happens: while the run is active it silently re-polls so each attempt
appears with its timestamp, and it does one final poll on the terminal transition to catch
the last tear-down row. Background polls are silent, so the "refreshing" spinner no longer
flickers; once the run is terminal the auto-poll stops, while the manual refresh control
stays available so a missed or not-yet-persisted tear-down row can always be refetched.
