import { DEPLOY_FIXER_AGENT_KIND } from '@cat-factory/contracts'
import type { AgentRunContext } from '@cat-factory/kernel'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { CODE_AWARE_TRAIT } from './traits.js'

// ---------------------------------------------------------------------------
// The `deploy-fixer`: the container agent dispatched when a deployment failed for a cause the
// platform has classified as fixable IN THE CHECKOUT (`manifest_invalid`).
//
// The classification is upstream and is the load-bearing part. This agent is never shown a
// failure it cannot address, which is why its prompt does not have to talk it out of the
// destructive repairs: it is not asked to decide whether the manifests are at fault, only to fix
// them once the platform has established that they are. The motivating run
// (`exec_194b231198454c7785f29589`) is exactly the failure it must never see: a Deployment
// rejected for a missing `image` where the manifest correctly said `image: "{{image}}"` and the
// workspace connection carried no `imageTemplate`. Handed that, any agent's only move is to
// hard-code an image, which turns the run green and permanently defeats per-PR substitution.
//
// It carries NO structured output and NO `FINAL_ANSWER_IN_REPLY`: its product is a pushed commit,
// exactly like the `ci-fixer`. Whether the repair worked is not something it is asked or trusted
// to report — the environment is provisioned again and the provider's verdict is the proof, the
// same rule the teardown probe and the bugfix reproduction proof are built on.
// ---------------------------------------------------------------------------

/**
 * The role half of the deploy-fixer's prompt: WHO it is and WHAT it is for.
 *
 * Split from the directives ({@link DEPLOY_FIXER_DIRECTIVES}) because a workspace may override a
 * kind's prompt, and an override replaces the role while the directives are re-applied on top.
 * The scope constraints below are not editorial content a workspace should be able to delete:
 * they are what keeps a machine-authored commit inside the deployment description and out of CI
 * configuration, so they belong on the side that survives an edit.
 */
export const DEPLOY_FIXER_ROLE_PROMPT = [
  'You are a deployment engineer. An automated pipeline tried to stand up an ephemeral',
  'environment for this service, and the platform rejected the deployment files this repository',
  'supplied. You are on the pull-request branch, and your job is to make those files valid so the',
  'deployment succeeds.',
  '',
  'The platform has already established that the fault is in this repository: causes outside it',
  '(an unset connection setting, a missing credential, an exhausted quota, an unpublished image)',
  'are classified separately and never reach you. So work the error as a defect in the files,',
  'not as a question about whether the files are the problem.',
  '',
  'Work from the rejection quoted for you. It comes from the platform that refused the',
  'deployment, so it names the object and usually the field at fault. Read the files that produce',
  'that object before changing anything, and make the minimal correct change.',
].join('\n')

/**
 * The directives half: the constraints on WHERE it may write and WHAT it may not do to get past
 * an error. Re-applied over any workspace override (see {@link DEPLOY_FIXER_ROLE_PROMPT}).
 *
 * The CI-configuration prohibition is a security constraint, not tidiness. This agent's commits
 * land on a branch a pipeline may then merge, and a workflow file that merges is a
 * credential-exfiltration path. An agent chasing a deployment error is a short step from
 * "the image is not published, so I will fix the workflow that publishes it", which is why the
 * boundary is stated to it here AND enforced by the classification that keeps image failures away
 * from it entirely.
 */
export const DEPLOY_FIXER_DIRECTIVES = [
  'Scope of your changes:',
  '- Edit only the deployment description: the manifests, chart, kustomization, compose file or',
  '  values this service deploys from, at the path the run context names.',
  '- Do NOT edit CI or automation configuration (`.github/workflows`, or any equivalent pipeline',
  '  definition). It is out of scope for a deployment repair, and a change there on a branch that',
  '  later merges is a security problem regardless of intent.',
  '- Do NOT continue, extend or refactor the application change already committed on this branch.',
  '  It is written and reviewed; the task described in your context is background, not your',
  '  assignment.',
  '',
  'Two repairs that look like progress and are not:',
  '- Do not weaken the deployment to get past the error. Removing a probe, dropping a resource',
  '  limit, deleting the object that will not apply, or replacing a templated value with a',
  '  literal all make the error go away and leave the service broken in a way nothing downstream',
  '  will catch until it is running.',
  '- Do not replace a `{{placeholder}}` with a hard-coded value. Those are filled by the',
  '  environment connection so the value can vary per deployment; freezing one is not a fix, it',
  '  silently disables the substitution for every future run.',
  '',
  'Commit your fix to the current branch (no new branch, no new pull request). The deployment is',
  'attempted again once you finish, and that attempt — not your own assessment — is what',
  'establishes whether the fix worked.',
].join('\n')

/**
 * The deploy-fixer's task prompt: COMPACT, and leading with the deployment failure.
 *
 * Compact for the reason `conflictResolverUserPrompt` is: the generic block-context prompt renders
 * the full task brief plus every prior agent's output (the architect's design, the coder's account
 * of the feature), which buries a one-line repair role. The observed failure mode of handing a
 * coding agent that context is that it resumes building the feature.
 *
 * The failure brief rides `priorOutputs` tagged as the deployer's, which is whose output it is.
 */
function deployFixerUserPrompt(context: AgentRunContext): string {
  const failure = context.priorOutputs.find((o) => o.agentKind === DEPLOY_FAILURE_PRIOR_KIND)
  const description = context.block.description?.trim()
  return [
    failure?.output ?? 'No deployment error was captured.',
    '',
    `Task the branch implements (background only): ${context.block.title}` +
      `${description ? `\n${description}` : ''}`,
  ].join('\n')
}

/**
 * The `agentKind` the deployment failure brief is tagged with in the fixer's `priorOutputs`. The
 * `deployer` step is what produced the failure, so it is what the entry is attributed to.
 */
export const DEPLOY_FAILURE_PRIOR_KIND = 'deployer'

export const DEPLOY_FIXER_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: DEPLOY_FIXER_AGENT_KIND,
    // No `systemPrompt` here: its prompt is BESPOKE and split `{ role, directives }`, so it is
    // declared in `BESPOKE_SYSTEM_PROMPTS` instead — the map the prompt editor, the run and a
    // registered variant all agree on. A flat `systemPrompt` on the registration would compile
    // and run, and would fail only later, when a workspace edited it and lost the write-scope
    // guardrail with it.
    traits: [CODE_AWARE_TRAIT],
    agent: {
      surface: 'container-coding',
      // The in-place fixer shape: push onto the PR head so the re-provision runs against the fix
      // and the eventual merge carries it. Single-repo deliberately, unlike the ci-fixer: a failed
      // provision is ONE service frame's environment.
      clone: { branch: 'pr', requirePr: true },
      // A fixer that finds nothing to change must not fail the job it arrives on: the
      // re-provision is what settles whether the deployment works, and an empty commit is a
      // legitimate (if unhelpful) round, not an infrastructure failure.
      noChangesTolerated: true,
    },
    userPrompt: deployFixerUserPrompt,
    // No `presentation`, so it stays out of the SPA's agent palette: it is not a step anybody
    // authors into a pipeline, it is what a failed deployment escalates to. Same as `ci-fixer`.
  },
]

/**
 * Register the deploy-fixer kind on the given registry. Called by `defaultAgentKindRegistry()`;
 * idempotent (the registry replaces by kind).
 */
export function registerDeployFixerAgent(registry: AgentKindRegistry): void {
  registry.registerAll(DEPLOY_FIXER_AGENT_KINDS)
}

export { DEPLOY_FIXER_AGENT_KIND }
