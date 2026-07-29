import type {
  ComposeFileRef,
  ComposeSource,
  RunRepoContext,
  VcsProvider,
} from '@cat-factory/kernel'
import {
  composeBaseDepth,
  composeProjectDir,
  composeSourcesNeedPrimaryRepo,
  describeComposeSource,
  materializedComposePath,
  normalizeComposeFileRefs,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Resolving an ordered list of `-f` compose layers whose text may come from the PRIMARY repo
// (the run's checkout / a shared stack's own clone), from a directly-supplied `inline` document,
// or from a path in ANOTHER repo read checkout-free through the workspace's VCS connection.
//
// This is the ONE place a foreign/inline layer is turned into "text + the checkout-relative path
// it will live at", shared by `ComposeEnvironmentProvider.provisionRecipe` and
// `SharedStackService.bringUp`. They consume it differently on purpose — the provider REWRITES
// every layer for isolation (so it reads the `path` layers itself, from the VCS, before the
// checkout even exists), while a shared stack runs its own committed layers AS AUTHORED off the
// clone and only needs the non-`path` ones materialized. The plan below therefore reports WHERE
// each layer goes and carries text ONLY for the layers that must be written; a `path` layer is
// left to its caller.
//
// The pure placement rules (project directory, host-escape base depth, materialized paths) live
// in kernel's `domain/compose-sources.ts` so both consumers cannot drift apart on them.
// ---------------------------------------------------------------------------

/**
 * Resolve a checkout-free {@link RunRepoContext} for another `owner/repo` — the workspace's VCS
 * connection, bound by the caller. Returns null when no connection can read that repo.
 */
export type ForeignRepoResolver = (coords: {
  owner: string
  repo: string
  provider?: VcsProvider
}) => Promise<RunRepoContext | null>

/** One planned `-f` layer. */
export interface ComposeLayerPlan {
  /** The normalized source the layer came from (for logging / error messages). */
  source: ComposeSource
  /** Checkout-relative path the layer is used at — where `-f` points. */
  path: string
  /**
   * Text to WRITE into the working tree before `up`. Present for `inline` / `repo` layers (which
   * have no home in the checkout until we put one there); absent for a `path` layer, which the
   * caller reads and handles itself.
   */
  content?: string
}

/** The resolved layer list plus the placement facts both consumers derive from it. */
export interface ComposeLayerPlanResult {
  layers: ComposeLayerPlan[]
  /** Compose `--project-directory`, checkout-relative (the first `path` layer's dir, else root). */
  projectDir: string
  /** The host-escape guard's base depth for {@link projectDir}. */
  baseDepth: number
  /** Whether any layer reads from the primary repo (⇒ a checkout/clone is required). */
  needsPrimaryRepo: boolean
}

/**
 * Plan an ordered layer list: normalize the bare-path shorthand, fetch every `inline` / `repo`
 * layer's text, and assign each layer the checkout-relative path it will be used at.
 *
 * Foreign repos are resolved ONCE per `owner/repo` and reused across every layer that names them
 * (a central infra repo commonly supplies several layers) — a resolve per layer would be the
 * banned N+1. Returns a blocking `error` string rather than throwing, because both callers turn a
 * failure here into a persisted `lastError` / a failed provision with the real cause attached.
 */
export async function planComposeLayers(
  refs: readonly ComposeFileRef[],
  deps: { resolveForeignRepo?: ForeignRepoResolver },
): Promise<ComposeLayerPlanResult | { error: string }> {
  const sources = normalizeComposeFileRefs(refs)
  if (sources.length === 0) return { error: 'No compose files are configured for this stack.' }
  const projectDir = composeProjectDir(sources)
  const layers: ComposeLayerPlan[] = []
  // One resolved context per `owner/repo`, shared by every layer naming it.
  const contexts = new Map<string, RunRepoContext | null>()

  for (const [index, source] of sources.entries()) {
    const path = materializedComposePath(source, index, projectDir)
    if (source.kind === 'path') {
      layers.push({ source, path })
      continue
    }
    if (source.kind === 'inline') {
      layers.push({ source, path, content: source.content })
      continue
    }
    const [owner, repo] = source.repo.split('/')
    if (!owner || !repo) {
      return { error: `Compose layer '${source.repo}' is not an "owner/repo" reference.` }
    }
    if (!deps.resolveForeignRepo) {
      return {
        error:
          `Compose layer '${describeComposeSource(source)}' reads from another repo, which needs a ` +
          `VCS connection this deployment does not have. Connect the provider, or supply the layer inline.`,
      }
    }
    const key = `${owner}/${repo}`
    if (!contexts.has(key)) {
      contexts.set(
        key,
        await deps.resolveForeignRepo({
          owner,
          repo,
          ...(source.provider ? { provider: source.provider } : {}),
        }),
      )
    }
    const ctx = contexts.get(key) ?? null
    if (!ctx) {
      return {
        error:
          `No VCS connection could read '${key}' for compose layer ` +
          `'${describeComposeSource(source)}'. Connect the matching provider and retry.`,
      }
    }
    const file = await ctx.repo.getFile(source.path, source.ref || ctx.baseBranch)
    if (!file) {
      return { error: `No compose file found at '${describeComposeSource(source)}'.` }
    }
    layers.push({ source, path, content: file.content })
  }

  return {
    layers,
    projectDir,
    baseDepth: composeBaseDepth(sources),
    needsPrimaryRepo: composeSourcesNeedPrimaryRepo(sources),
  }
}
