ALTER TABLE "agent_runs" ADD COLUMN "service_id" text;--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "service_id" text;--> statement-breakpoint
CREATE INDEX "idx_agent_runs_service" ON "agent_runs" ("service_id");--> statement-breakpoint
CREATE INDEX "idx_blocks_service" ON "blocks" ("service_id");--> statement-breakpoint
WITH RECURSIVE anc(workspace_id, id, root_id, parent_id) AS (
  SELECT workspace_id, id, id AS root_id, parent_id FROM blocks
  UNION ALL
  SELECT a.workspace_id, a.id, b.id AS root_id, b.parent_id
  FROM anc a
  JOIN blocks b ON b.workspace_id = a.workspace_id AND b.id = a.parent_id
)
UPDATE blocks SET service_id = a.workspace_id || ':' || a.root_id
FROM anc a
WHERE a.workspace_id = blocks.workspace_id AND a.id = blocks.id AND a.parent_id IS NULL;--> statement-breakpoint
UPDATE agent_runs SET service_id = b.service_id
FROM blocks b
WHERE b.workspace_id = agent_runs.workspace_id AND b.id = agent_runs.block_id;