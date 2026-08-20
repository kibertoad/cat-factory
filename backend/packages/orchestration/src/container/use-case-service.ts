import type {
  InlineUseCaseGenerator,
  InlineUseCaseRegistry,
  InlineUseCaseScope,
  Logger,
} from '@cat-factory/kernel'
import type { SpendService } from '@cat-factory/spend'
import { InlineUseCaseService } from '../modules/useCases/InlineUseCaseService.js'
import { LlmInlineUseCaseGenerator } from '../modules/useCases/LlmInlineUseCaseGenerator.js'
import type { CoreDependencies } from './dependencies.js'

/**
 * The public inline use-case surface, assembled from the resolved registry, the deployment's model
 * wiring and the workspace budget safeguard.
 *
 * ALWAYS built, unlike an optional module: the registry and the spend guard are both always
 * present, and the one part that can be missing (a model provider) is a state the service REPORTS
 * rather than a reason for the surface to vanish. Discovery has to answer on a deployment with no
 * provider at all, or a wrapper cannot tell a catalog nobody registered from a surface that is not
 * there.
 */
export function createInlineUseCaseService(
  deps: CoreDependencies,
  wiring: { registry: InlineUseCaseRegistry; spend: SpendService; logger: Logger },
): InlineUseCaseService {
  const generator = deps.inlineUseCaseGenerator ?? createInlineUseCaseGenerator(deps)
  return new InlineUseCaseService({
    registry: wiring.registry,
    // An invocation is a billable model call that no run start gates, so it answers to the SAME
    // budget safeguard `RunAdmission` applies before a run and the bug hunt applies before its
    // ranking, including its ACCOUNT and USER tiers, which `isOverBudget` consults only when the
    // scope names them. Passing the workspace alone would let an account that has spent its
    // monthly ceiling keep generating indefinitely through whichever of its workspaces is still
    // under its own limit, which is the opposite of what putting this spend inside the
    // deployment's budget was for.
    isOverBudget: (scope: InlineUseCaseScope) =>
      wiring.spend.isOverBudget(scope.workspaceId, {
        ...(scope.accountId ? { accountId: scope.accountId } : {}),
        ...(scope.userId ? { userId: scope.userId } : {}),
      }),
    logger: wiring.logger,
    ...(generator ? { generator } : {}),
  })
}

/**
 * The producer behind an inline use-case invocation, built from the model dependencies every
 * facade already wires. A facade that configured a model gets working use cases with no
 * use-case-specific wiring, the judge-registry pattern the bug-hunt assessor follows.
 *
 * Absent provider ⇒ undefined, and the service refuses every invocation with a 503 naming the
 * deployment-level gap while discovery still answers with the catalog and each model marked
 * unavailable.
 *
 * Its own file, with the service factory above it, rather than a factory in `container/modules.ts`
 * or a literal inside `createCore`: both are at their size budgets, and a split is the correct
 * response to that ceiling, never a raised number.
 */
function createInlineUseCaseGenerator(deps: CoreDependencies): InlineUseCaseGenerator | undefined {
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new LlmInlineUseCaseGenerator({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The deployment-aware catalog resolver, so a use case naming a catalog model id takes the
    // same route a pipeline step pinned to it would. Deliberately NOT the preset slice the other
    // inline callers ride: a use case is workspace-agnostic and names its own models, so there is
    // no per-kind preset default that could reach in and substitute one.
    resolveBlockModel: deps.requirementReviewResolveModel,
    // In local mode an ambient Claude Code / Codex login CAN serve a subscription ref inline, so
    // such an option is offered there instead of being reported container-only.
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  })
}
