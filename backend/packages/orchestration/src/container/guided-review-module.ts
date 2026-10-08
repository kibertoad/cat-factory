import type { SpendService } from '@cat-factory/spend'
import type { CoreDependencies } from '../container.js'
import { GuidedReviewService } from '../modules/guidedReview/GuidedReviewService.js'
import { inlineModelResolutionDeps } from './inline-model-deps.js'

export interface GuidedReviewModule {
  service: GuidedReviewService
}

export interface GuidedReviewModuleInput {
  dependencies: CoreDependencies
  /** The workspace budget every billable guided-review model call answers to. */
  spend: SpendService
}

/** Built when a facade wires the guided-review repository; absent otherwise. */
export function createGuidedReviewModule(
  input: GuidedReviewModuleInput,
): GuidedReviewModule | undefined {
  const { dependencies, spend } = input
  const { guidedReviewRepository } = dependencies
  if (!guidedReviewRepository) return undefined
  return {
    service: new GuidedReviewService({
      repository: guidedReviewRepository,
      runner: dependencies.guidedReviewRunner,
      driver: dependencies.guidedReviewDriver ?? 'deployment',
      resolveRepoFilesForCoords: dependencies.resolveRepoFilesForCoords,
      runInitiatorScope: dependencies.runInitiatorScope,
      modelProviderResolver: dependencies.modelProviderResolver,
      modelProvider: dependencies.modelProvider,
      ...inlineModelResolutionDeps(dependencies),
      isOverBudget: (workspaceId) => spend.isOverBudget(workspaceId),
      idGenerator: dependencies.idGenerator,
      clock: dependencies.clock,
      logger: dependencies.logger,
    }),
  }
}
