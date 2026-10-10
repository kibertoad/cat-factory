import type { ComposeSource } from '@cat-factory/contracts'

// The shape-level helpers (`normalizeComposeFileRef(s)`, `describeComposeSource`) live in
// contracts because the SPA needs them too; re-exported here so a backend call site resolves the
// whole vocabulary — shape AND placement — from this one module.
export {
  normalizeComposeFileRef,
  normalizeComposeFileRefs,
  describeComposeSource,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// COMPOSE SOURCES — the pure rules for an ordered list of `-f` compose layers whose text may
// come from the primary repo, from a directly-supplied document, or from another repo. The
// contract is `@cat-factory/contracts`' `compose-sources.ts`; the IO-bearing resolution is
// `@cat-factory/integrations`' `modules/compose/compose-sources.ts`, shared by the compose
// environment provider and the shared-stack bring-up.
//
// Everything here is pure so BOTH consumers derive the same project directory, the same
// host-escape base depth and the same materialized paths — a foreign layer landing somewhere
// the escape guard measures differently on one path than the other is exactly the kind of
// silent divergence this module exists to prevent.
// ---------------------------------------------------------------------------

/**
 * The directory a materialized (non-`path`) layer is written into when the layer itself doesn't
 * name a path, relative to the compose PROJECT DIRECTORY. Kept out of any source tree the repo
 * owns so a materialized layer can never collide with a committed file, and stable across
 * bring-ups so a re-provision overwrites rather than accumulates.
 */
const MATERIALIZED_COMPOSE_DIR = '.cat-factory/compose'

/** The directory portion of a repo-relative path (`docker/dev.yml` → `docker`; a root file → ''). */
export function composePathDir(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx < 0 ? '' : normalized.slice(0, idx)
}

/**
 * The compose PROJECT DIRECTORY for a layer list, relative to the checkout root: the directory of
 * the FIRST `path` layer, or the root when there is none.
 *
 * It keys off the first `path` layer rather than the first layer OF ANY KIND because the project
 * directory is what every layer's relative references (build contexts, bind mounts, `env_file`s)
 * resolve against — so it must be the directory the repo AUTHORED its compose files to run from.
 * A leading `inline`/`repo` layer prepended to an in-repo stack must not silently move that
 * anchor to the checkout root and break every relative path in the layers below it.
 */
export function composeProjectDir(sources: readonly ComposeSource[]): string {
  for (const source of sources) {
    if (source.kind === 'path') return composePathDir(source.path)
  }
  return ''
}

/**
 * The host-escape guard's base depth for a layer list: how deep the project directory sits below
 * the checkout root, so a `../` in a compose file is judged against where the daemon actually
 * resolves it. Derived from {@link composeProjectDir}, so a layer list with no `path` layer gets
 * the STRICTEST depth (0) — a foreign or inline document has no in-repo home to be relative to,
 * and must not widen what the guard tolerates.
 */
export function composeBaseDepth(sources: readonly ComposeSource[]): number {
  const dir = composeProjectDir(sources)
  return dir ? dir.split('/').length : 0
}

/** Join a directory prefix onto a relative path (either may be empty). */
function joinPath(dir: string, rest: string): string {
  return dir ? `${dir}/${rest}` : rest
}

/**
 * Where a layer's text ends up in the working tree, as a checkout-relative path:
 *
 * - a `path` layer stays exactly where the repo put it (its siblings resolve as authored);
 * - an `inline` layer with its own `path` is honoured verbatim;
 * - everything else gets a deterministic generated path under the project directory, keyed by the
 *   layer's POSITION so two layers naming the same basename in different repos can't collide.
 *
 * Deterministic rather than random because the bring-up re-provisions the same project directory:
 * a re-run must overwrite its previous materialization instead of leaving a growing pile of stale
 * `-f` candidates behind in the working tree.
 */
export function materializedComposePath(
  source: ComposeSource,
  index: number,
  projectDir: string,
): string {
  if (source.kind === 'path') return source.path
  if (source.kind === 'inline' && source.path) return source.path
  const base = source.kind === 'repo' ? sanitizeSegment(source.path) : 'inline'
  return joinPath(projectDir, `${MATERIALIZED_COMPOSE_DIR}/${index}-${base}.yml`)
}

/** Reduce a path to a single safe filename stem (`docker/dev.yml` → `dev`). */
function sanitizeSegment(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const stem = base.replace(/\.(ya?ml)$/i, '')
  const safe = stem.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'layer'
}

/**
 * Whether the layer list needs the PRIMARY repo on disk — true as soon as any layer is a `path`.
 * A list of only `inline` / `repo` layers describes a stack with no repo of its own, which is what
 * lets a deployment declare one entirely in code (or an operator paste one in) with no clone URL.
 */
export function composeSourcesNeedPrimaryRepo(sources: readonly ComposeSource[]): boolean {
  return sources.some((source) => source.kind === 'path')
}
