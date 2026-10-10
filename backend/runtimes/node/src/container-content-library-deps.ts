import { createTierInstallationResolvers, LlmFragmentSelector } from '@cat-factory/agents'
import { SERVICE_CATALOG_CIPHER_INFO } from '@cat-factory/integrations'
import type {
  GitHubClient,
  GitHubInstallationRepository,
  ModelProviderResolver,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { AppConfig, ServiceCatalogConfig } from '@cat-factory/server'
import { WebCryptoSecretCipher, resolveUrlSafetyPolicy } from '@cat-factory/server'
import type { DrizzleDb } from './db/client.js'
import {
  DrizzleFragmentBriefRepository,
  DrizzleFragmentSourceRepository,
  DrizzlePromptFragmentRepository,
} from './repositories/fragments.js'
import {
  DrizzleAccountSkillRepository,
  DrizzleSkillSourceRepository,
} from './repositories/skills.js'
import {
  DrizzleApiContractRepository,
  DrizzleFoundationalServiceRepository,
  DrizzleFoundationalServiceSourceRepository,
} from './repositories/foundationalServices.js'
import { DrizzleServiceCatalogConnectionRepository } from './repositories/drizzle/serviceCatalog.js'

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
export function selectNodeFragmentLibraryDeps(opts: {
  config: AppConfig
  env: NodeJS.ProcessEnv
  db: DrizzleDb
  githubClient: GitHubClient | undefined
  installations: GitHubInstallationRepository
  workspaces: WorkspaceRepository
  modelProviderResolver: ModelProviderResolver
}): Partial<CoreDependencies> {
  const { config, db, githubClient, installations, workspaces, modelProviderResolver } = opts
  if (!config.fragmentLibrary.enabled) return {}
  // The shared tier resolver: workspace tier by direct binding, account tier through the
  // account's boards (PAT-connect / local-synthetic rows carry no usable accountId).
  const resolvers = createTierInstallationResolvers({ installations, workspaces })
  return {
    promptFragmentRepository: new DrizzlePromptFragmentRepository(db),
    fragmentBriefRepository: new DrizzleFragmentBriefRepository(db),
    fragmentSourceRepository: new DrizzleFragmentSourceRepository(db),
    // Repo-sourced fragments read guideline files through the workspace's App
    // installation; only wired when a real GitHub client is available (parity with
    // the Worker — hand-authored fragments work without it).
    ...(githubClient ? { githubClient, resolveFragmentInstallationId: resolvers.forOwner } : {}),
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
 * Wire the repo-sourced Claude Skills library (ADR 0024) for
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
  workspaces: WorkspaceRepository,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const resolvers = createTierInstallationResolvers({ installations, workspaces })
  return {
    accountSkillRepository: new DrizzleAccountSkillRepository(db),
    skillSourceRepository: new DrizzleSkillSourceRepository(db),
    // Repo-sourced skills read through the account's App installation; the source sync
    // is only wired when a real GitHub client is available (parity with the Worker).
    ...(githubClient ? { githubClient, resolveSkillInstallationId: resolvers.forAccount } : {}),
  }
}

/**
 * Wire the foundational-services catalog (backend/docs/adr/0031-foundational-services.md) for the
 * Node facade — the mirror of the Worker's `selectFoundationalServiceDeps`.
 *
 * Deliberately UNGATED, unlike the two libraries above: a service's contracts can be uploaded
 * directly, so the catalog is useful on a deployment that wants neither repo-sourced prompt
 * fragments nor Claude skills. The feature is opt-in by CONTENT — a deployment that registers
 * nothing gets an empty catalog, which leaves every design prompt exactly as it was.
 *
 * Reuses the FRAGMENT installation resolver, which already answers for both tiers — the same
 * pair this catalog is keyed by — and is wired only when a real GitHub client is available
 * (parity with the Worker; a direct upload needs none).
 */
export function selectNodeFoundationalServiceDeps(
  db: DrizzleDb,
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
  workspaces: WorkspaceRepository,
  /** The service-catalog config slice: its encryption key and its own URL allow-list. */
  serviceCatalog: ServiceCatalogConfig,
): Partial<CoreDependencies> {
  const resolvers = createTierInstallationResolvers({ installations, workspaces })
  const urlPolicy = resolveUrlSafetyPolicy(serviceCatalog)
  return {
    foundationalServiceRepository: new DrizzleFoundationalServiceRepository(db),
    apiContractRepository: new DrizzleApiContractRepository(db),
    foundationalServiceSourceRepository: new DrizzleFoundationalServiceSourceRepository(db),
    ...(githubClient ? { githubClient, resolveFragmentInstallationId: resolvers.forOwner } : {}),
    // The developer-portal connection that FEEDS this catalog. Gated on the encryption key rather
    // than ungated like the catalog itself, and for the reason the catalog is ungated: a contract
    // can be uploaded with no credential at all, but a PORTAL cannot be read without one, so a
    // connection surface with nothing to seal it is a surface that can only fail.
    ...(serviceCatalog.encryptionKey
      ? {
          serviceCatalogConnectionRepository: new DrizzleServiceCatalogConnectionRepository(db),
          serviceCatalogSecretCipher: new WebCryptoSecretCipher({
            masterKeyBase64: serviceCatalog.encryptionKey,
            info: SERVICE_CATALOG_CIPHER_INFO,
          }),
          ...(urlPolicy ? { serviceCatalogUrlSafetyPolicy: urlPolicy } : {}),
        }
      : {}),
  }
}
