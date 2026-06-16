-- Capture structured failure diagnostics for a "bootstrap repo" run, so a crash
-- is recorded as more than a one-line `error` and the board can classify it (and
-- decide whether a retry is likely to help). Conventions per 0010/0017.
--
--   failure  — JSON-encoded BootstrapFailure {kind, message, detail, hint,
--              occurredAt, lastSubtasks} written when a run faults. `kind` is one
--              of preflight | dispatch | evicted | timeout | agent | unknown. The
--              container's stdout/stderr can't be folded in (an evicted container
--              is gone), so for `evicted`/`timeout` the `hint` points at the
--              Cloudflare container logs. NULL while running/succeeded, and for
--              older failed rows recorded before this column existed (their
--              one-line `error` still renders).

ALTER TABLE bootstrap_jobs ADD COLUMN failure TEXT;
