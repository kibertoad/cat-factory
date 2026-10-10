import { createTierInstallationResolvers } from '@cat-factory/agents'
import { SERVICE_CATALOG_CIPHER_INFO } from '@cat-factory/integrations'
import type { CoreDependencies } from '@cat-factory/orchestration'
import type { ServiceCatalogConfig } from '@cat-factory/server'
import { resolveUrlSafetyPolicy } from '@cat-factory/server'
import { LlmFragmentSelector } from './ai/LlmFragmentSelector'
import type { AppConfig } from './config'
import { buildModelProviderResolver } from './container-model-resolver.js'
import type { Env } from './env'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { D1AccountSkillRepository } from './repositories/D1AccountSkillRepository'
import {
  D1ApiContractRepository,
  D1FoundationalServiceRepository,
  D1FoundationalServiceSourceRepository,
} from './repositories/D1FoundationalServiceRepository'
import { D1FragmentBriefRepository } from './repositories/D1FragmentBriefRepository'
import { D1FragmentSourceRepository } from './repositories/D1FragmentSourceRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1PromptFragmentRepository } from './repositories/D1PromptFragmentRepository'
import { D1ServiceCatalogConnectionRepository } from './repositories/D1ServiceCatalogConnectionRepository'
import { D1SkillSourceRepository } from './repositories/D1SkillSourceRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'

// The Worker facade's CONTENT-LIBRARY dependency selectors: the prompt-fragment library, the
// repo-sourced Claude Skills library, and the foundational-services catalog together with the
// developer-portal connection that feeds it.
//
// Extracted from `container.ts` when the service-catalog connection pushed that file past its size
// ratchet, along the seam the NODE facade already uses: its `container-content-library-deps.ts` is
// this file's twin, holding the same three selectors. Keeping the split symmetric is the point:
// a reader comparing the facades finds each selector in the same place, which is what the
// runtime-symmetry rule is for.

/**
 * Build the prompt-fragment library's concrete ports when opted in (ADR 0006):
 * the two D1 repositories, the relevance selector (LLM when configured, else the
 * core deterministic matcher via `fragmentSelector: undefined`), and the
 * installation resolver repo-source sync uses to read guideline repos through the
 * tier's GitHub installation. Returns `{}` when disabled, so `createCore` leaves
 * the `fragmentLibrary` module unassembled and the engine uses manual fragmentIds.
 */
export function selectFragmentLibraryDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  // The shared tier resolver: workspace tier by direct binding, account tier bound directly
  // (migration 0017) with a fallback through the account's own boards (a per-workspace PAT
  // connect stores no accountId on its installation row).
  const resolvers = createTierInstallationResolvers({
    installations: new D1GitHubInstallationRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
  })
  return {
    promptFragmentRepository: new D1PromptFragmentRepository({ db }),
    fragmentBriefRepository: new D1FragmentBriefRepository({ db }),
    fragmentSourceRepository: new D1FragmentSourceRepository({ db }),
    resolveFragmentInstallationId: resolvers.forOwner,
    ...(config.fragmentLibrary.selector === 'llm'
      ? {
          fragmentSelector: new LlmFragmentSelector({
            modelProviderResolver: buildModelProviderResolver(env, db),
            modelRef: config.agents.routing.default.ref,
          }),
        }
      : {}),
  }
}

/**
 * Build the repo-sourced Claude Skills library's concrete ports when opted in
 * (ADR 0024). Skills live in ONE tier (the account), so the
 * installation resolver is account-only. Gated on the same `fragmentLibrary.enabled`
 * flag as the fragment library (both are the repo-sourced prompt library). Returns
 * `{}` when disabled, so `createCore` leaves the skill module unassembled.
 */
export function selectSkillLibraryDeps(
  _env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const resolvers = createTierInstallationResolvers({
    installations: new D1GitHubInstallationRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
  })
  return {
    accountSkillRepository: new D1AccountSkillRepository({ db }),
    skillSourceRepository: new D1SkillSourceRepository({ db }),
    resolveSkillInstallationId: resolvers.forAccount,
  }
}

/**
 * Build the foundational-services catalog's concrete ports (migration 0073,
 * backend/docs/adr/0031-foundational-services.md).
 *
 * Deliberately UNGATED, unlike the two libraries above: a service can be registered with its
 * contracts uploaded directly, so the catalog is useful on a deployment that wants neither
 * repo-sourced prompt fragments nor Claude skills. The feature is opt-in by CONTENT: a
 * deployment that registers nothing gets an empty catalog, and an empty catalog renders as the
 * "none are registered" line, which leaves every design prompt exactly as it was.
 *
 * It reuses the FRAGMENT installation resolver (`resolveFragmentInstallationId`), which already
 * answers for both tiers, the same pair this catalog is keyed by. `selectFragmentLibraryDeps`
 * sets the identical resolver when it is enabled; the two agree by construction because both
 * come from `createTierInstallationResolvers`.
 */
export function selectFoundationalServiceDeps(
  db: D1Database,
  /** The service-catalog config slice: its encryption key and its own URL allow-list. */
  serviceCatalog: ServiceCatalogConfig,
): Partial<CoreDependencies> {
  const resolvers = createTierInstallationResolvers({
    installations: new D1GitHubInstallationRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
  })
  const urlPolicy = resolveUrlSafetyPolicy(serviceCatalog)
  return {
    foundationalServiceRepository: new D1FoundationalServiceRepository({ db }),
    apiContractRepository: new D1ApiContractRepository({ db }),
    foundationalServiceSourceRepository: new D1FoundationalServiceSourceRepository({ db }),
    resolveFragmentInstallationId: resolvers.forOwner,
    // The developer-portal connection that FEEDS this catalog (migration 0097). Gated on the
    // encryption key rather than ungated like the catalog itself, and for the reason the catalog
    // is ungated: a contract can be uploaded with no credential at all, but a PORTAL cannot be
    // read without one, so a connection surface with nothing to seal it can only ever fail.
    ...(serviceCatalog.encryptionKey
      ? {
          serviceCatalogConnectionRepository: new D1ServiceCatalogConnectionRepository({ db }),
          serviceCatalogSecretCipher: new WebCryptoSecretCipher({
            masterKeyBase64: serviceCatalog.encryptionKey,
            info: SERVICE_CATALOG_CIPHER_INFO,
          }),
          ...(urlPolicy ? { serviceCatalogUrlSafetyPolicy: urlPolicy } : {}),
        }
      : {}),
  }
}
