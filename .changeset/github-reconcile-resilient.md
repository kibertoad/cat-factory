---
'@cat-factory/worker': patch
---

Stop the GitHub reconcile cron from spamming a dead installation, and make the
pass resilient.

- **`listStale` excludes tombstoned installations.** The query now joins
  `github_installations` and requires `deleted_at IS NULL`, so the repos of an
  uninstalled/suspended installation are no longer swept every cron tick (there is
  no token to mint for them). The existing `unsuspend`/reinstall webhook clears the
  installation tombstone, which re-enables its repos automatically — the
  "stop until reactivated" gate.
- **Reactive tombstone on a gone installation.** Previously one stale repo whose
  installation had been uninstalled/revoked threw a 404 out of the whole
  `reconcileStaleRepos` loop — aborting every other repo's resync and logging
  `github reconcile failed` at error level every 2 minutes forever. Each repo is now
  reconciled independently; a 404/410 from minting the _installation token_ (the
  installation is gone, e.g. a missed uninstall webhook) tombstones the installation
  so the next pass skips all its repos, and the failure is logged once at `warn`
  (scoped to the mint error and to 404/410 — never 401, which can be a transient
  app-JWT fault). Other faults stay `error`. The pass returns the count scheduled.
