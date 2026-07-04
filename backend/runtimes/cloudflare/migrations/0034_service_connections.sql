-- Connections between services (phase 1 of the service-connections initiative —
-- see docs/initiatives/service-connections.md).
--
-- `service_connections`: a `service`-type frame's directed connections to the other
-- services it USES (stored on the consumer end), serialized as a JSON array of
-- `{ serviceBlockId, description? }`. Drawn as board edges and the source of the
-- per-task "involved services" choices. Stored as JSON, mirroring `frontend_config`.
ALTER TABLE blocks ADD COLUMN service_connections TEXT;
-- `involved_service_ids`: a task's selected connected service frames (JSON array of
-- frame block ids) that are directly involved beyond the task's own service — they
-- spin up as ephemeral environments too, and the coding agent may change their repos.
ALTER TABLE blocks ADD COLUMN involved_service_ids TEXT;
