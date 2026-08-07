-- The tool servers (MCP) one dispatch wired and dropped, as a typed column on the agent-context
-- snapshot. Mirrors the D1 telemetry migration 0006_agent_context_tool_servers.sql; see
-- docs/initiatives/mcp-maturation.md for why it left the `extras` bag.
ALTER TABLE "telemetry"."agent_context_snapshots" ADD COLUMN "tool_servers" text DEFAULT '[]' NOT NULL;