-- Optimistic-concurrency revision for execution runs. Bumped on every write and
-- guarded by the execution repo's compareAndSwap, so a human-action write (resolve
-- decision / approve / request changes) that raced the durable driver is detected and
-- retried on fresh state instead of silently clobbering the other writer's snapshot.
-- Applies to the whole agent_runs table; only kind='execution' rows use it today.
ALTER TABLE agent_runs ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
