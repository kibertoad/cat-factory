// The domain works directly with the wire entity types defined once in
// @cat-factory/contracts. Re-exported here so the rest of the core imports its
// vocabulary from a single place (`../domain/types`) rather than reaching into
// the contracts package everywhere.
export type {
  AgentKind,
  AgentState,
  Block,
  BlockLevel,
  BlockStatus,
  BlockType,
  Decision,
  ExecutionInstance,
  ExecutionStatus,
  Pipeline,
  PipelineStep,
  Position,
  SpendStatus,
  Workspace,
  WorkspaceSnapshot,
} from '@cat-factory/contracts'
