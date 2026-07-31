import type { UpdateWorkspaceSettingsInput, WorkspaceSettings } from '@cat-factory/kernel'
import { normalizeWorkspaceMetadata } from '@cat-factory/kernel'

/**
 * Fold a settings patch over the stored row: a field the caller supplied wins, anything omitted
 * is kept.
 *
 * Split out of `WorkspaceSettingsService.update`, which now holds only the CROSS-FIELD rules —
 * the task-limit/mode coherence, the review-friction thresholds, the provisioning pair. Those
 * are the part with judgement in it; this is a field-by-field fold that grows by one line every
 * time a setting is added, and having the two in one function is what pushed `update` over its
 * complexity budget.
 *
 * The `!== undefined` checks are not noise: every one of them guards a NULLABLE field, where
 * `null` is a real value the caller can set (clear the budget, clear the manifest id) and `??`
 * would silently reinstate the stored value instead.
 */
export function mergeWorkspaceSettings(
  current: WorkspaceSettings,
  patch: UpdateWorkspaceSettingsInput,
): WorkspaceSettings {
  return {
    waitingEscalationMinutes: patch.waitingEscalationMinutes ?? current.waitingEscalationMinutes,
    taskLimitMode: patch.taskLimitMode ?? current.taskLimitMode,
    taskLimitShared:
      patch.taskLimitShared !== undefined ? patch.taskLimitShared : current.taskLimitShared,
    taskLimitPerType:
      patch.taskLimitPerType !== undefined ? patch.taskLimitPerType : current.taskLimitPerType,
    storeAgentContext: patch.storeAgentContext ?? current.storeAgentContext,
    publishPrVerificationReport:
      patch.publishPrVerificationReport ?? current.publishPrVerificationReport,
    artifactRetentionDays: patch.artifactRetentionDays ?? current.artifactRetentionDays,
    kaizenEnabled: patch.kaizenEnabled ?? current.kaizenEnabled,
    delegateAgentsToRunnerPool:
      patch.delegateAgentsToRunnerPool ?? current.delegateAgentsToRunnerPool,
    reviewFrictionMode: patch.reviewFrictionMode ?? current.reviewFrictionMode,
    reviewFrictionWarnCount: patch.reviewFrictionWarnCount ?? current.reviewFrictionWarnCount,
    reviewFrictionBlockCount:
      patch.reviewFrictionBlockCount !== undefined
        ? patch.reviewFrictionBlockCount
        : current.reviewFrictionBlockCount,
    reviewFrictionBlockStuckMinutes:
      patch.reviewFrictionBlockStuckMinutes !== undefined
        ? patch.reviewFrictionBlockStuckMinutes
        : current.reviewFrictionBlockStuckMinutes,
    spendCurrency: patch.spendCurrency !== undefined ? patch.spendCurrency : current.spendCurrency,
    spendMonthlyLimit:
      patch.spendMonthlyLimit !== undefined ? patch.spendMonthlyLimit : current.spendMonthlyLimit,
    defaultProvisionType:
      patch.defaultProvisionType !== undefined
        ? patch.defaultProvisionType
        : current.defaultProvisionType,
    defaultProvisionManifestId:
      patch.defaultProvisionManifestId !== undefined
        ? patch.defaultProvisionManifestId
        : current.defaultProvisionManifestId,
    // The custom-metadata bag is REPLACED wholesale when supplied (see the update contract): the
    // editor submits every declared field, so a key it omits was cleared and must go.
    // Normalisation drops a cleared value's key entirely, keeping "unset" distinguishable from
    // "set to nothing" for every reader (above all an external-tool URL resolver).
    metadata:
      patch.metadata !== undefined ? normalizeWorkspaceMetadata(patch.metadata) : current.metadata,
  }
}
