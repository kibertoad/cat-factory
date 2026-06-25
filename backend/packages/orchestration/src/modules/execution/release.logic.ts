// The pure post-release-health verdict logic + the post-release-health / on-call
// agent-kind constants now live in `@cat-factory/kernel` (`domain/gate-logic.ts`) so the
// built-in gate suite (`@cat-factory/gates`) can author the gate depending only on kernel.
// Re-exported here for the engine's existing internal call sites.
export {
  POST_RELEASE_HEALTH_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  type ReleaseGateVerdict,
  classifyReleaseHealth,
  describeRegressedSignals,
} from '@cat-factory/kernel'
