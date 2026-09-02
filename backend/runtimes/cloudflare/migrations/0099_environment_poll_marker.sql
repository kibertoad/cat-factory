-- The trail a status poll that SUCCEEDS leaves behind.
--
-- The provisioning log records a poll that throws and a poll that transitions an environment to
-- `failed`. A poll that answers cleanly wrote nothing at all, so a readiness wait that polled for
-- four minutes left two log rows a second apart at the create and nothing after them, and nothing
-- in the data distinguished "nothing polled" from "polling is not logged". The environment
-- investigation read that absence as the absence of polling and stated it as established fact.
--
-- A row per poll is the wrong shape at a ten-second cadence. These two columns are enough to tell
-- a four-minute wait from no wait at all: `last_polled_at` is exact (a lost race still leaves the
-- later stamp) and `poll_count` is a FLOOR, written from the count the poll read at its start.
ALTER TABLE environments ADD COLUMN last_polled_at INTEGER;
ALTER TABLE environments ADD COLUMN poll_count INTEGER NOT NULL DEFAULT 0;
