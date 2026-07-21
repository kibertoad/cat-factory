import {
  FragmentLibraryService,
  FragmentSourceService,
  SkillCatalogService,
  SkillRunResolver,
  SkillSourceService,
} from '@cat-factory/agents'
import type { AppCaches, DocumentContentResolver } from '@cat-factory/kernel'
import type { CoreDependencies } from './container.js'
import { FragmentTitleService } from './modules/fragmentLibrary/FragmentTitleService.js'

// The two content-library module factories (prompt fragments + repo-sourced Claude Skills),
// extracted from `container.ts` for file-size hygiene. Pure composition helpers: each takes the
// app-owned `CoreDependencies` bag, assembles its services when the prerequisite repositories are
// wired, and returns undefined so the feature stays cleanly opt-in. `createCore` calls them. Their
// return-shape interfaces live here too (beside the factories that produce them); `container.ts`
// re-exports them so existing importers are unaffected.

/** The prompt-fragment library's services, present only when configured (ADR 0006). */
export interface FragmentLibraryModule {
  /**
   * Per-tier CRUD + the merged-catalog resolver. The run path consumes it through
   * `resolveBodiesForRun` (wired as the engine's `fragmentResolver`), so an already-
   * selected id — a frame's `serviceFragmentIds` / a block pin — resolves against the
   * merged tenant catalog (managed + document-backed fragments included). Only the
   * automatic per-run relevance selector (`resolveForRun`) is retired from the run path.
   */
  libraryService: FragmentLibraryService
  /** Repo-sourced fragments; present only when the GitHub client + source repo are wired. */
  sourceService?: FragmentSourceService
  /**
   * The inline "auto-generate title" LLM helper behind the fragment editor's button; present only
   * when a model provider + routing-default ref are wired. Absent ⇒ the endpoint returns 503.
   */
  titleService?: FragmentTitleService
}

/**
 * The repo-sourced Claude Skills library's services, present only when configured
 * (docs/initiatives/repo-skills.md). Assembles whenever `accountSkillRepository` is wired.
 */
export interface SkillLibraryModule {
  /** The account skill-catalog read (cached), consumed by the management surface + the run path. */
  catalogService: SkillCatalogService
  /** Repo-source sync; present only when the GitHub client + source repo are wired. */
  sourceService?: SkillSourceService
  /**
   * Resolves a `skill` step's picked skill (instructions + resource bodies at the pinned commit)
   * for the execution engine (`skillResolver`). Present only when the source repo + GitHub client
   * are wired (it needs them to fetch resource bodies) — the same prerequisites as the sync
   * service. Absent ⇒ a skill step fails loudly at dispatch.
   */
  runResolver?: SkillRunResolver
}

/**
 * Assemble the prompt-fragment library when its fragment repository is present.
 * The library service (CRUD + the per-run catalog resolver) always assembles;
 * the repo-source service additionally needs the GitHub client, the source
 * repository and an installation resolver. The selector is optional — absent it
 * falls back to deterministic matching. Returns undefined so the feature stays
 * cleanly opt-in (the engine then uses the block's manual fragmentIds).
 */
export function createFragmentLibraryModule(
  deps: CoreDependencies,
  documentContentResolver: DocumentContentResolver | undefined,
  caches: AppCaches,
): FragmentLibraryModule | undefined {
  const { promptFragmentRepository } = deps
  if (!promptFragmentRepository) return undefined

  const libraryService = new FragmentLibraryService({
    promptFragmentRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    selector: deps.fragmentSelector,
    // An explicitly-injected resolver (tests/conformance) wins; otherwise use the
    // one the document-source module built from this deployment's providers.
    documentContentResolver: deps.documentContentResolver ?? documentContentResolver,
    catalogCache: caches.fragmentCatalog,
    documentBodyCache: caches.fragmentDocumentBody,
  })

  const sourceService =
    deps.fragmentSourceRepository && deps.githubClient && deps.resolveFragmentInstallationId
      ? new FragmentSourceService({
          fragmentSourceRepository: deps.fragmentSourceRepository,
          promptFragmentRepository,
          githubClient: deps.githubClient,
          resolveInstallationId: deps.resolveFragmentInstallationId,
          idGenerator: deps.idGenerator,
          clock: deps.clock,
          // A sync/unlink mutates the same catalog the library caches — route its
          // invalidation through the library so the eviction policy stays in one place.
          invalidateCatalog: (ownerKind, ownerId) =>
            libraryService.invalidateCatalogTier(ownerKind, ownerId),
        })
      : undefined

  // The inline "auto-generate title" helper: assembles whenever a model provider is wired (a
  // routing-default ref is required for it to be `enabled`). Reuses the document-planner /
  // requirement-review default refs — a title is a small, cheap completion.
  const titleService = new FragmentTitleService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.documentPlannerModel ?? deps.requirementReviewModel,
  })

  return { libraryService, sourceService, titleService }
}

/**
 * Assemble the repo-sourced Claude Skills library when its skill repository is
 * present (docs/initiatives/repo-skills.md). The catalog read always assembles; the
 * repo-source sync additionally needs the GitHub client, the source repository and an
 * installation resolver. Returns undefined so the feature stays cleanly opt-in.
 */
export function createSkillLibraryModule(
  deps: CoreDependencies,
  caches: AppCaches,
): SkillLibraryModule | undefined {
  const { accountSkillRepository } = deps
  if (!accountSkillRepository) return undefined

  const catalogService = new SkillCatalogService({
    accountSkillRepository,
    catalogCache: caches.skillCatalog,
  })

  const sourceService =
    deps.skillSourceRepository && deps.githubClient && deps.resolveSkillInstallationId
      ? new SkillSourceService({
          skillSourceRepository: deps.skillSourceRepository,
          accountSkillRepository,
          githubClient: deps.githubClient,
          resolveInstallationId: deps.resolveSkillInstallationId,
          idGenerator: deps.idGenerator,
          clock: deps.clock,
          // A sync/unlink mutates the same catalog the read caches — route its
          // invalidation through the catalog service so the eviction policy stays in one place.
          invalidateCatalog: (accountId) => catalogService.invalidate(accountId),
        })
      : undefined

  // The run-path resolver needs the source repo (for the resource repo owner/name) + the GitHub
  // client + an installation resolver to fetch resource bodies at the pinned commit — the same
  // prerequisites as the sync service, so it assembles under the same guard. It also drives the
  // dispatch-time freshness probe (slice 4) through the sync service, which is built under the
  // identical guard, so it's always present here.
  const runResolver =
    deps.skillSourceRepository && deps.githubClient && deps.resolveSkillInstallationId
      ? new SkillRunResolver({
          workspaceRepository: deps.workspaceRepository,
          catalogService,
          skillSourceRepository: deps.skillSourceRepository,
          githubClient: deps.githubClient,
          resolveInstallationId: deps.resolveSkillInstallationId,
          syncSource: sourceService
            ? (accountId, sourceId) => sourceService.sync(accountId, sourceId)
            : undefined,
        })
      : undefined

  return { catalogService, sourceService, runResolver }
}
