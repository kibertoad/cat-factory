---
'@cat-factory/acceptance': minor
---

Give `reset` a `--purge-repos` flag that reclaims the provider side: the issues a pass filed as the
reporter, and the contents a scaffold run pushed.

Both were previously stated as leftovers because an `admin` key structurally cannot reach either. The
emptying is recoverable by construction: an ordinary commit on top of the current tip (so the previous
tree stays in history and one `git revert` restores it), every ref tagged at the sha it held before it
is touched, and the recovery command printed with the report.
