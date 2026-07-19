import { LlmFragmentSelector } from '@cat-factory/agents'
import type {
  FragmentOwnerKind,
  GitHubClient,
  GitHubInstallationRepository,
  ModelProviderResolver,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { AppConfig } from '@cat-factory/server'
import type { DrizzleDb } from './db/client.js'
import {
  DrizzleFragmentSourceRepository,
  DrizzlePromptFragmentRepository,
} from './repositories/fragments.js'
import {
  DrizzleAccountSkillRepository,
  DrizzleSkillSourceRepository,
} from './repositories/skills.js'

// The Node facade's content-library dependency selectors (prompt-fragment library + repo-sourced
// Claude Skills), extracted from `container.ts` for file-size hygiene and symmetric with the shared
// `container-content-libraries.ts` split. Each returns a `Partial<CoreDependencies>` the module
// factory assembles from, or `{}` when the library is disabled. Called from `buildNodeContainer`.

/**
 * Wire the prompt-fragment library (ADR 0006) for the Node facade when opted in,
 * mirroring the Worker's `selectFragmentLibraryDeps`: the two Drizzle repositories,
 * the installation resolver repo-source sync uses to read guideline repos through the
 * tier's GitHub installation, and — in `llm` selector mode — the shared
 * `LlmFragmentSelector` over the Node model provider (else the core deterministic
 * matcher, via `fragmentSelector: undefined`). Disabled → `{}` and the module stays
 * unassembled (the engine falls back to the static built-in catalog).
 */
export function selectNodeFragmentLibraryDeps(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  db: DrizzleDb,
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
  modelProviderResolver: ModelProviderResolver,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const resolveFragmentInstallationId = async (
    ownerKind: FragmentOwnerKind,
    ownerId: string,
  ): Promise<number | null> => {
    if (ownerKind === 'workspace') {
      return (await installations.getByWorkspace(ownerId))?.installationId ?? null
    }
    const active = await installations.listActive()
    return active.find((i) => i.accountId === ownerId)?.installationId ?? null
  }
  return {
    promptFragmentRepository: new DrizzlePromptFragmentRepository(db),
    fragmentSourceRepository: new DrizzleFragmentSourceRepository(db),
    // Repo-sourced fragments read guideline files through the workspace's App
    // installation; only wired when a real GitHub client is available (parity with
    // the Worker — hand-authored fragments work without it).
    ...(githubClient ? { githubClient, resolveFragmentInstallationId } : {}),
    ...(config.fragmentLibrary.selector === 'llm'
      ? {
          fragmentSelector: new LlmFragmentSelector({
            modelProviderResolver,
            modelRef: config.agents.routing.default.ref,
          }),
        }
      : {}),
  }
}

/**
 * Wire the repo-sourced Claude Skills library (docs/initiatives/repo-skills.md) for
 * the Node facade when opted in, mirroring the Worker's `selectSkillLibraryDeps`: the
 * two Drizzle repositories and the account-only installation resolver the repo-source
 * sync uses. Gated on the same `fragmentLibrary.enabled` flag (both are the repo-sourced
 * prompt library). Disabled → `{}` and the module stays unassembled.
 */
export function selectNodeSkillLibraryDeps(
  config: AppConfig,
  db: DrizzleDb,
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const resolveSkillInstallationId = async (accountId: string): Promise<number | null> => {
    const active = await installations.listActive()
    return active.find((i) => i.accountId === accountId)?.installationId ?? null
  }
  return {
    accountSkillRepository: new DrizzleAccountSkillRepository(db),
    skillSourceRepository: new DrizzleSkillSourceRepository(db),
    // Repo-sourced skills read through the account's App installation; the source sync
    // is only wired when a real GitHub client is available (parity with the Worker).
    ...(githubClient ? { githubClient, resolveSkillInstallationId } : {}),
  }
}
