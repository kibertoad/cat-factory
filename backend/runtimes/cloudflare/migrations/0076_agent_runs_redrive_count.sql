-- Per-run re-drive count (docs/initiatives/observability-logging-gaps.md, D4 / slice 4.1).
--
-- The sweepers already knew how many runs they re-drove per pass, but only for that pass's log
-- line: the per-run history lived in an in-memory `orphanedSince` map holding a timestamp and
-- nothing else. That map dies with the process on Node and with the isolate on Cloudflare, where
-- the sweep additionally logs only aggregates (`{redriven: 3}`, no run ids) — so "was this run
-- re-driven three times or is this the first?" had no answer anywhere.
--
-- Deliberately NOT rev-guarded and deliberately outside the re-drive's own write: this counts
-- something that happened TO the run rather than deriving a value FROM it, so two racing sweepers
-- double-counting is a far better outcome than a lost update, and a `rev` bump here would collide
-- with the driver's own writes and let bookkeeping fail a re-drive.
--
-- Default 0 is honest for every existing row: a run that was re-driven before this column existed
-- has no recoverable count, and 0 is what "we do not know of any" has to read as. The counter is
-- kept when a run recovers — needing three re-drives is exactly what an operator wants to see
-- about a run that eventually succeeded.

ALTER TABLE agent_runs
  ADD COLUMN redrive_count INTEGER NOT NULL DEFAULT 0;
