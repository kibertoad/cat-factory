// Per-workspace, per-agent-kind generation settings, mirroring `@cat-factory/contracts`
// (agent-settings.ts). Today one knob: the output-token ceiling a kind's inline calls run under.
// A kind absent from the store inherits the deployment routing default, and a pipeline step's own
// `stepOptions.maxOutputTokens` still overrides whatever is set here.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  UpdateWorkspaceAgentSettingsInput,
  WorkspaceAgentSettings,
} from '@cat-factory/contracts'
export { MAX_AGENT_MAX_OUTPUT_TOKENS, MIN_AGENT_MAX_OUTPUT_TOKENS } from '@cat-factory/contracts'
