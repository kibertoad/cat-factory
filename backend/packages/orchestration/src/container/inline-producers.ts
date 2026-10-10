// The inline producers a facade gets FOR FREE from the model dependencies it already wires: a
// judge's verdict, a tester-quality review, an environment diagnosis, a fork chat, the bug-hunt
// ranking and the monorepo adoption suggestion. One cohesive group, extracted from
// `modules.ts` when that file hit its size budget (the `review-modules.ts` move is the
// precedent), and re-exported from it so the composition root keeps one import site.
//
// What makes them one group is the shape they all share, and the property that shape buys: each
// needs NO feature-specific wiring, only a model provider, so a deployment that can run a
// requirements review can run every one of them. Each returns `undefined` when no provider is
// configured, and every caller treats that as a PASS-THROUGH: the judge step advances, the QC
// companion is skipped, a failed environment stays unexplained, the hunt returns its candidates
// unranked, the bootstrap parks with a plan that says the suggestion is unavailable. A facade or
// harness may inject its own implementation instead (conformance does, for deterministic
// verdicts), which is the first thing each factory checks.
//
// A producer that needs a REPOSITORY as well as a model is not one of these and stays in
// `modules.ts` with the rest of its module (the document interviewer owns a session store).

import type {
  BugHuntAssessor,
  EnvironmentInvestigator,
  JudgeAssessor,
  MonorepoAdoptionAdvisor,
} from '@cat-factory/kernel'
import { BugHuntAssessorService } from '../modules/bugHunt/BugHuntAssessorService.js'
import { MonorepoAdoptionAdvisorService } from '../modules/bootstrap/MonorepoAdoptionAdvisorService.js'
import { EnvironmentInvestigationService } from '../modules/execution/EnvironmentInvestigationService.js'
import { ForkChatService } from '../modules/execution/ForkChatService.js'
import { JudgeService } from '../modules/execution/JudgeService.js'
import { TesterQualityReviewService } from '../modules/execution/TesterQualityReviewService.js'
import { resolveBlockRunContext } from './blockRunContext.js'
import { inlineModelResolutionDeps } from './inline-model-deps.js'
import type { CoreDependencies } from '../container.js'

/**
 * The inline bug-hunt ranking model, built from the same dependencies the judge/reviewer
 * assessors ride, so a facade that wired a model gets a working hunt ranking with no
 * hunt-specific wiring (the judge-registry pattern). Absent provider ⇒ undefined, and the hunt
 * returns its candidates unranked with a stated reason.
 */
export function createBugHuntAssessor(deps: CoreDependencies): BugHuntAssessor | undefined {
  if (deps.bugHuntAssessor) return deps.bugHuntAssessor
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new BugHuntAssessorService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order, wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    ...(deps.logger ? { logger: deps.logger } : {}),
  })
}

/**
 * The inline monorepo-adoption advisor, built from the same model dependencies the bug-hunt and
 * judge assessors ride, so a facade that wired a model gets a working adoption suggestion with
 * no bootstrap-specific wiring. Absent provider ⇒ undefined, and the run parks with a plan that
 * says the suggestion is unavailable rather than one that says there was nothing to decide.
 */
export function createMonorepoAdoptionAdvisor(
  deps: CoreDependencies,
): MonorepoAdoptionAdvisor | undefined {
  if (deps.monorepoAdoptionAdvisor) return deps.monorepoAdoptionAdvisor
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new MonorepoAdoptionAdvisorService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    ...inlineModelResolutionDeps(deps),
    ...(deps.logger ? { logger: deps.logger } : {}),
    // The same sink the container executor and the bootstrap dispatch record through, so the
    // survey's prompt is readable beside the apply's on the run's own panel. Wired here rather
    // than per facade: it is already a core dependency, and a facade asked to remember a second
    // wiring site for it is a facade where one of the two halves goes missing.
    ...(deps.agentContextObservability
      ? { agentContextObservability: deps.agentContextObservability }
      : {}),
  })
}

/**
 * Build the inline reviewer for the test quality-control companion. It resolves its model
 * exactly like the requirements reviewer (block pin → workspace per-kind default → routing
 * default). Returns `undefined` when no model provider is configured, so the Tester gate's QC
 * step is a pass-through in unconfigured facades / tests.
 */
export function createTesterQualityReviewer(
  deps: CoreDependencies,
): TesterQualityReviewService | undefined {
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new TesterQualityReviewService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order, wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
  })
}

/**
 * The default {@link JudgeAssessor}: the inline LLM verdict producer behind every judge step.
 * Built from the SAME model-provider dependencies the inline reviewers use, which is why judges
 * need no per-facade wiring at all: a facade that can run a requirements review can run a
 * judge. Returns undefined when no provider is wired, and a facade/harness may inject its own
 * `judgeAssessor` (conformance does, for a deterministic verdict); either way an
 * absent/disabled assessor makes every judge step a pass-through.
 */
export function createJudgeAssessor(deps: CoreDependencies): JudgeAssessor | undefined {
  if (deps.judgeAssessor) return deps.judgeAssessor
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new JudgeService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order, wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
  })
}

/**
 * The default {@link EnvironmentInvestigator}: the inline diagnosis behind the deployer's
 * environment-investigation loop. Built from the SAME model-provider dependencies the inline
 * reviewers and judges use, so a facade that can run a requirements review can investigate a
 * failed environment with no investigation-specific wiring at all.
 *
 * Returns undefined when no provider is wired, and a facade or harness may inject its own
 * `environmentInvestigator` (the conformance harness does, for a deterministic verdict); either
 * way an absent or disabled investigator makes the loop a pass-through, and a failed provision is
 * terminal and unexplained exactly as it was before.
 */
export function createEnvironmentInvestigator(
  deps: CoreDependencies,
): EnvironmentInvestigator | undefined {
  if (deps.environmentInvestigator) return deps.environmentInvestigator
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new EnvironmentInvestigationService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order, wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
    // Its prompt is a member of `INLINE_ENGINE_SYSTEM_PROMPTS`, so the prompt editor offers it and
    // an edit saved there has to reach the call. Without this the editor would show a baseline no
    // code path sends and silently discard what a workspace wrote.
    ...(deps.agentPromptRepository
      ? {
          resolveSystemPromptOverride: async (workspaceId: string, agentKind: string) =>
            (await deps.agentPromptRepository!.head(workspaceId, agentKind))?.text ?? undefined,
        }
      : {}),
  })
}

/**
 * Build the inline grounded-chat responder for the implementation-fork decision phase. Resolves
 * its model exactly like the requirements reviewer / doc interviewer (block pin → workspace
 * per-kind default → routing default). Returns `undefined` when no model provider is configured,
 * so the fork chat degrades to a canned "chat unavailable" reply in unconfigured facades / tests
 * while pick / custom keep working. Stateless: the chat rides the coder step, no session store.
 */
export function createForkChatService(deps: CoreDependencies): ForkChatService | undefined {
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new ForkChatService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order, wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
  })
}
