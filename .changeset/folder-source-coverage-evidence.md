---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/app': patch
---

Fix a `folder`-mode foundational source retiring a live service on the strength of directories it
declined to list, and report what a scan actually covered.

The zero-contract disposition tested whether the scan found candidates. A walk stopped by a cap
before it reached ANY candidate — a recursive link over a wide tree whose specs sit below the
visited prefix — reports exactly that, so it read as "this folder holds no contracts", tombstoned
the service and pinned the commit, which kept it retired until the folder changed again. The test
is now whether the walk had the COVERAGE to conclude anything: absence of evidence is transient
(keep the prior row, leave the pin), while a truncated pass that DID produce contracts still pins.

The sync result's `truncated` boolean is replaced by `folderScan`: `complete` / `truncated` /
`missing`, null for the modes that walk nothing. `missing` is a new third answer — git cannot store
an empty directory, so an empty root listing means the folder is gone rather than empty, and the
two need opposite reactions from whoever linked it. A never-synced link whose head probe finds no
commit for its path reports it too, so a mistyped folder no longer syncs "successfully" forever.
Both non-`complete` outcomes are logged, which is the only standing signal an autorefresh leaves.

Two bounds keep an unbounded discovery honest. Package, lockfile and compiler manifests are no
longer contract candidates, so a folder scan's file budget is not spent on `package.json` before
the walk reaches the specs. A candidate larger than the host contents API's own 1 MiB ceiling is
declined unread — above that the read returns an empty body anyway — and counted as skipped rather
than dropped in silence. Each skipped candidate is now also named in the log with its reason; a
duplicate contract id was previously undiagnosable, since the losing document is absent under a
name that is present.
