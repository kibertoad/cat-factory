// Per-workspace agent system-prompt overrides, mirroring `@cat-factory/contracts`
// (agent-prompts.ts). An append-only revision log per agent kind: the highest revision is what
// every run in the workspace sends, and a revision whose `text` is null is the deliberate way
// back to the prompt the product ships.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  AgentPromptDetail,
  AgentPromptRevision,
  AgentPromptSummary,
  SaveAgentPromptInput,
} from '@cat-factory/contracts'
