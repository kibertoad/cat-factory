import type {
  AgentDispatchContext,
  AgentRunContext,
  DelegationBrief,
  InjectedContextFile,
  OwnServiceContext,
  VcsProvider,
} from '@cat-factory/kernel'
import {
  type AgentKindRegistry,
  bugFixGuidanceFor,
  composeBlockSystemPrompt,
  standardsDeliveredAsFiles,
  standardsVerbosityFor,
  userPromptFor,
} from '@cat-factory/agents'
import { dispatchSystemPromptFor } from './promptOverrides.js'

// ---------------------------------------------------------------------------
// The BRIEF: what an agent is told, as a value, independent of what runs it.
//
// The container path composed this inline on its way into a harness job body, which was fine
// while a harness was the only thing that could receive it. A DELEGATED step needs the same
// material handed to a system that has never heard of our job bodies, and the one property that
// must hold across both is that they are told the SAME thing: the workspace's prompt override, the
// best-practice standards it agreed on, the service the work belongs to, the linked documents.
//
// So the shared composition lives here and BOTH callers consume it. What the container adds on top
// is genuinely about the container (what the execution environment can and cannot do, how to stop
// what it backgrounded, where to write the PR description the harness lifts), which is why those
// layers stay at the dispatch chokepoint rather than moving in: telling an external executor to
// write `.cat-pr-description.md` would be an instruction about a file nothing there reads.
//
// `brief.spec.ts` pins the shared half against a real container body built from one context.
// ---------------------------------------------------------------------------

/** The half of an agent's instructions that is the same whatever executes the step. */
export interface AgentBriefCore {
  /**
   * The role prompt with the workspace's override applied, the block's best-practice standards
   * folded at this kind's verbosity, and its trait guidance. NOT the finished container system
   * prompt: the container-dispatch directives, the follow-up sentinel, the skills fold and the
   * tool-server section are layered onto this at the container chokepoint.
   */
  roleSystemPrompt: string
  /** The generic block-context prompt (or the kind's own), with its wrappers already applied. */
  userPrompt: string
  /** The `.cat-context/` files this dispatch was prepared with. */
  contextFiles: InjectedContextFile[]
}

/**
 * Compose the executor-independent half of a dispatch's instructions.
 *
 * `dispatch` carries the resolved checkout facts for the kinds whose own prompt names a branch.
 * Both callers have one (a delegated executor gets a checkout too: its own), which is the
 * difference between this and an inline caller, and it is why the parameter is required here
 * rather than optional as it is on `userPromptFor`.
 */
export function composeAgentBriefCore(
  context: AgentRunContext,
  registry: AgentKindRegistry,
  dispatch: AgentDispatchContext,
): AgentBriefCore {
  return {
    roleSystemPrompt: composeRoleSystemPrompt(context, registry),
    // `materialized: true` on BOTH paths: linked context renders as an index pointing at the
    // `.cat-context/` files rather than folding their bodies into the prompt, because the files
    // themselves travel beside it. A delegated executor that cannot materialise them has to fold
    // the bodies into its own input instead: the brief carries both halves so either is possible,
    // and rendering the index for one caller and the bodies for the other would mean the two
    // executors were briefed differently on the same task.
    userPrompt: userPromptFor(context, registry, { materialized: true, dispatch }),
    contextFiles: [...(context.injectedContextFiles ?? [])],
  }
}

/**
 * The role prompt for one dispatch: the workspace's override (or the shipped track prompt), the
 * block's resolved standards at this kind's verbosity, and its trait guidance.
 *
 * Its own exported function because two dispatch paths must produce the identical string from one
 * context. It is the piece a workspace actually EDITS, so a drift here is the failure that matters
 * most: the standards a team agreed on reaching one executor and not the other, with nothing
 * anywhere reporting it.
 */
export function composeRoleSystemPrompt(
  context: AgentRunContext,
  registry: AgentKindRegistry,
): string {
  return composeBlockSystemPrompt(
    dispatchSystemPromptFor(context, registry),
    context.block,
    registry.standardsDelivery(context.agentKind),
    standardsDeliveredAsFiles(context.injectedContextFiles),
    standardsVerbosityFor(context.agentKind, registry),
  )
}

/** The repo + branch facts a delegated dispatch resolved, as the brief names them. */
export interface DelegationBriefTarget {
  repo: DelegationBrief['repo']
  branches: DelegationBrief['branches']
  /** Where the work came from, when it came from a tracker. */
  trackerRef?: NonNullable<DelegationBrief['task']['trackerRef']>
}

/**
 * Build the {@link DelegationBrief} for one delegated dispatch.
 *
 * `ownService` is FILLED IN rather than forwarded optionally: the brief's contract is a
 * discriminated result, and an omitted one reads to a model exactly like a task whose product is
 * obvious. A context that carries none genuinely does not know which system the work belongs to,
 * and `not-under-a-service` is what says so.
 */
export function composeDelegationBrief(
  context: AgentRunContext,
  registry: AgentKindRegistry,
  args: {
    correlationKey: string
    workspaceId: string
    blockId: string
    runId: string
    stepIndex: number
    target: DelegationBriefTarget
  },
): DelegationBrief {
  const dispatch: AgentDispatchContext = {
    baseBranch: args.target.branches.base,
    // The executor checks out the work branch: a delegated step is a producer, and the branch every
    // step of this run's pipeline shares is the one its change has to land on.
    checkoutBranch: args.target.branches.work,
    workBranch: args.target.branches.work,
    // One repo. A delegated executor is handed one repository and one branch pair; the multi-repo
    // fan-out is a property of OUR harness's sibling checkouts, and claiming it here would have a
    // kind's prompt describe checkouts the external system never makes.
    multiRepo: false,
  }
  const core = composeAgentBriefCore(context, registry, dispatch)
  // Bug-fix guidance rides the brief for the same reason it rides a container coding dispatch: it
  // is about the WORK (fix the reported defect, do not merely satisfy the reproduction test), not
  // about the machine. Empty for every kind and every run that no `repro-test` preceded.
  const bugFix = bugFixGuidanceFor(context)
  return {
    correlationKey: args.correlationKey,
    workspaceId: args.workspaceId,
    // The same value `task.id` carries, stated twice because the two are different contracts: this
    // one is the LOOKUP KEY `deps.repoFiles` takes beside the workspace, and `task` is the work's
    // identity as an executor records it. An executor keying its repository read off the identity
    // is one rename away from a resolver that answers nothing.
    blockId: args.blockId,
    runId: args.runId,
    stepIndex: args.stepIndex,
    agentKind: context.agentKind,
    task: {
      id: args.blockId,
      title: context.block.title,
      description: context.block.description,
      ...(args.target.trackerRef ? { trackerRef: args.target.trackerRef } : {}),
    },
    repo: args.target.repo,
    branches: args.target.branches,
    systemPrompt: bugFix ? `${core.roleSystemPrompt}\n\n${bugFix}` : core.roleSystemPrompt,
    userPrompt: core.userPrompt,
    contextFiles: core.contextFiles,
    ownService: ownServiceFor(context),
  }
}

/** The discriminated own-service answer, defaulting to the one that SAYS the platform does not know. */
function ownServiceFor(context: AgentRunContext): OwnServiceContext {
  return context.ownService ?? { stated: false, reason: 'not-under-a-service' }
}

/** Narrow a repo projection's stored provider to the union, defaulting to the pre-column value. */
export function briefRepoProvider(provider: VcsProvider | undefined): VcsProvider {
  return provider ?? 'github'
}
