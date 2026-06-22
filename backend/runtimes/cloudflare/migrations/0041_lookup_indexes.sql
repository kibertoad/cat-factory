-- Two lookup indexes for hot single-column queries that previously fell through to a
-- full table scan because the only covering index had a different leading column.
--
--  * services.frame_block_id — `ServiceRepository.getByFrameBlock(frameBlockId)` resolves
--    the service that owns a frame WITHOUT an account_id in hand, so it could not use the
--    composite `idx_services_frame (account_id, frame_block_id)` (account_id is the leading
--    column). This lookup runs in a loop while walking a block's ancestry on EVERY agent
--    run's repo resolution (see resolveRepoTarget) and on board reads, so the scan is hot.
--  * blocks.id — `BlockRepository.findById(blockId)` looks a block up by id alone (no
--    workspace_id), so it could not use the primary key `(workspace_id, id)` and scanned the
--    whole — and largest — table. Block ids are only unique within a workspace, so this is a
--    plain (non-unique) lookup index, matching the `LIMIT 1` semantics of the query.
CREATE INDEX idx_services_frame_block ON services (frame_block_id);
CREATE INDEX idx_blocks_id ON blocks (id);
