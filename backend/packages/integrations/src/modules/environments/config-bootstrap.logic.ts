import type {
  BootstrapConfigResult,
  BootstrapEnvironmentRepoInput,
  EnvironmentProvider,
  RepoValidationResult,
  RunRepoContext,
} from '@cat-factory/kernel'
import type { ConfigRepairDispatch } from './EnvironmentConnectionService.js'

/** Deterministic head branch for the PR-mode config bootstrap (idempotent re-runs). */
export const BOOTSTRAP_CONFIG_BRANCH = 'cat-factory/env-config'

/**
 * Write the generated config files: a direct commit, or (in PR mode) create the config
 * branch off the target head when it doesn't yet exist, commit onto it, and open the PR.
 * Extracted so its branch/PR conditionals don't nest under the generation guards
 * (keeps max-depth ≤ 4).
 */
export async function writeGeneratedConfig(
  repo: RunRepoContext['repo'],
  opts: {
    message: string
    changed: { path: string; content: string }[]
    writeBranch: string
    targetBranch: string
    prMode: boolean
    prBranchHead: string | null
  },
): Promise<void> {
  const { message, changed, writeBranch, targetBranch, prMode, prBranchHead } = opts
  if (!prMode) {
    await repo.commitFiles({ branch: writeBranch, message, files: changed })
    return
  }
  if (!prBranchHead) {
    const base = await repo.headSha(targetBranch)
    if (base) await repo.createBranch(writeBranch, base)
  }
  await repo.commitFiles({ branch: writeBranch, message, files: changed })
  if (!prBranchHead) {
    await repo.openPullRequest({
      title: message,
      head: writeBranch,
      base: targetBranch,
      body: 'Automated provider configuration bootstrap.',
    })
  }
}

/**
 * Write the mechanically-generated config (skipping unchanged files), committing directly or —
 * in PR mode — onto {@link BOOTSTRAP_CONFIG_BRANCH}. Returns the branch actually written to and
 * whether anything was committed. No-op (nothing committed) when the provider needs an agent or
 * produced no files.
 */
export async function commitGeneratedConfig(
  bound: RunRepoContext,
  generated: BootstrapConfigResult,
  input: BootstrapEnvironmentRepoInput,
  targetBranch: string,
  readRepoFile: (path: string, ref?: string) => ReturnType<RunRepoContext['repo']['getFile']>,
): Promise<{ committed: boolean; writeBranch: string }> {
  let committed = false
  let writeBranch = targetBranch
  if (!generated.needsAgent && generated.files.length) {
    const prMode = !!input.openPr
    let prBranchHead: string | null = null
    if (prMode) {
      writeBranch = BOOTSTRAP_CONFIG_BRANCH
      prBranchHead = await bound.repo.headSha(writeBranch)
    }
    const compareBranch = prMode && prBranchHead ? writeBranch : targetBranch

    const changed: { path: string; content: string }[] = []
    for (const file of generated.files) {
      const existing = await readRepoFile(file.path, compareBranch)
      if (!existing || existing.content !== file.content) changed.push(file)
    }
    if (changed.length) {
      const message = generated.commitMessage ?? 'chore: bootstrap environment provider config'
      await writeGeneratedConfig(bound.repo, {
        message,
        changed,
        writeBranch,
        targetBranch,
        prMode,
        prBranchHead,
      })
      committed = true
    }
  }
  return { committed, writeBranch }
}

/**
 * When validation failed and the caller opted into the repair agent (and one is available),
 * ensure the PR branch exists, dispatch the durable `env-config-repair` run, and return the
 * outcome (used-agent flag, repair job id, and the — possibly repointed — write branch).
 * Pass-through (no dispatch) otherwise.
 */
export async function maybeDispatchConfigRepair(opts: {
  provider: EnvironmentProvider
  bound: RunRepoContext
  validation: RepoValidationResult
  input: BootstrapEnvironmentRepoInput
  workspaceId: string
  targetBranch: string
  writeBranch: string
  dispatchConfigRepair: ((input: ConfigRepairDispatch) => Promise<{ jobId: string }>) | undefined
}): Promise<{ usedAgent: boolean; repairJobId: string | undefined; writeBranch: string }> {
  const { provider, bound, validation, input, workspaceId, targetBranch, dispatchConfigRepair } =
    opts
  let writeBranch = opts.writeBranch
  let usedAgent = false
  let repairJobId: string | undefined
  if (
    !validation.ok &&
    input.allowAgentFallback &&
    provider.describeRepairAgent &&
    dispatchConfigRepair
  ) {
    usedAgent = true
    if (input.openPr && writeBranch === targetBranch) {
      const prBranchHead = await bound.repo.headSha(BOOTSTRAP_CONFIG_BRANCH)
      if (!prBranchHead) {
        const base = await bound.repo.headSha(targetBranch)
        if (base) {
          await bound.repo.createBranch(BOOTSTRAP_CONFIG_BRANCH, base)
          await bound.repo.openPullRequest({
            title: 'chore: repair environment provider config',
            head: BOOTSTRAP_CONFIG_BRANCH,
            base: targetBranch,
            body: 'Automated provider configuration repair.',
          })
        }
      }
      writeBranch = BOOTSTRAP_CONFIG_BRANCH
    }
    const started = await dispatchConfigRepair({
      workspaceId,
      owner: input.owner,
      repo: input.repo,
      gitRef: writeBranch,
      issues: validation.issues,
      inputs: input.inputs,
    })
    repairJobId = started.jobId
  }
  return { usedAgent, repairJobId, writeBranch }
}
