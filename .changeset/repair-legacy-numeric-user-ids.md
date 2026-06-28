---
'@cat-factory/server': patch
---

Repair pre-#94 numeric user ids on read so a stale row can't brick the board.

PR #94 re-keyed user ids (block `createdBy`, execution `initiatedBy`) from the GitHub
numeric id to the canonical `usr_*` string with no data migration. The wire contract now
types these as `string | null`, and the server ships rows without validating them against
the contract, so a single pre-#94 row made the SPA's response validation reject the entire
workspace snapshot and the board failed to load with "Can't reach the backend".

The shared row→domain mapper (used by both the D1 and Drizzle stores) now drops a
non-string legacy id to null on read. The stale number is an old GitHub id that matches no
`usr_*` user, so dropping it loses nothing real. This repair is temporary and marked for
removal after the 2026-07-15 migration grace cutoff.
