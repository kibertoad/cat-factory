-- The per-service TESTING CONTEXT: freeform prose an operator writes about how to test a service,
-- injected verbatim into every tester prompt for it (the pipeline testers and the environment dry
-- run's prober alike).
--
-- A column on `blocks` rather than a table of its own, for the same reason `provisioning` and
-- `service_connections` are columns: it is one service-frame-owned value the engine reads off the
-- frame it has already walked to, so a table would buy a second read and a second repository for
-- nothing. It is non-sensitive by contract (it reaches the model in the prompt); a real secret
-- belongs in `test_secrets`, which this prose refers to by key.
ALTER TABLE blocks ADD COLUMN testing_context TEXT;
