---
'@cat-factory/local-server': patch
---

Namespace local-mode containers per installation (ADR 0026 D5). Every managed job + warm-pool container is now tagged with a stable, secret-derived install id (a Docker `cat-factory.install` label; the Apple `container` name prefix), and the reaper/adopter/enumerations filter strictly on it. A machine running two local installs against one container daemon can no longer adopt, reap, or re-lease a neighbour's container — closing the warm-pool cross-install `HARNESS_SHARED_SECRET` poisoning vector.
