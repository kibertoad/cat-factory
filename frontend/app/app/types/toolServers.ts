// Tool server (MCP) operability shapes: what this deployment declared, and what a probe answered.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth). The probe
// STATUS and the not-probeable REASON in particular are vocabularies both sides must agree about —
// the backend decides them, this app maps each member to translated copy plus a remedy — so a
// member added on one side only renders as a blank chip rather than failing to compile.

export type {
  StepToolServers,
  ToolServerUnavailableReason,
  ToolServerAllowedToolsCheck,
  ToolServerCredential,
  ToolServerNotProbeableReason,
  ToolServerOAuthGrant,
  ToolServerOAuthStatus,
  ToolServerProbeResult,
  ToolServerProbeStatus,
  ToolServerTransport,
  ToolServerView,
  ToolServersView,
} from '@cat-factory/contracts'
