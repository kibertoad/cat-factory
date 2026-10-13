import type { SpendService } from '@cat-factory/spend'
import type { CoreDependencies } from '../container.js'
import { PrAssessmentService } from '../modules/prAssessment/PrAssessmentService.js'
import { inlineModelResolutionDeps } from './inline-model-deps.js'
import type { RiskPoliciesModule } from './module-shapes.js'

export interface PrAssessmentModule {
  service: PrAssessmentService
}

export interface PrAssessmentModuleInput {
  dependencies: CoreDependencies
  /** The workspace budget the assessment's model call answers to. */
  spend: SpendService
  riskPolicies: RiskPoliciesModule | undefined
}

/** Built when the risk-policy library is wired, since every verdict is judged against it. */
export function createPrAssessmentModule(
  input: PrAssessmentModuleInput,
): PrAssessmentModule | undefined {
  const { dependencies, spend, riskPolicies } = input
  if (!riskPolicies) return undefined
  return {
    service: new PrAssessmentService({
      listRiskPolicies: (workspaceId) => riskPolicies.service.list(workspaceId),
      resolveRepoFilesForCoords: dependencies.resolveRepoFilesForCoords,
      runInitiatorScope: dependencies.runInitiatorScope,
      modelProviderResolver: dependencies.modelProviderResolver,
      modelProvider: dependencies.modelProvider,
      ...inlineModelResolutionDeps(dependencies),
      isOverBudget: (workspaceId) => spend.isOverBudget(workspaceId),
      clock: dependencies.clock,
    }),
  }
}
