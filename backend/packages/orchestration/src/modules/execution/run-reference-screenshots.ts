import type {
  AgentRunContext,
  BinaryArtifactStore,
  DocumentRepository,
  ReferenceScreenshot,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { resolveBlockReferences } from './block-reference-set.js'
import type { BlockReference } from './block-reference-set.js'

// ---------------------------------------------------------------------------
// The container half of a task's reference designs: turning the reference SET (which artifact is
// the reference for each view) into the FILES a capturing agent reads off disk under
// `.cat-context/reference-screenshots/`.
//
// The naming happens in the engine rather than in the container for one reason: the file name is
// how the agent learns the view name, and the view name is what the gate pairs on. Left to the
// harness, a sanitiser change in an image the deployment has not rolled out yet would rename the
// views a run reports, and every pair would come apart with nothing failing.
// ---------------------------------------------------------------------------

/** The file extension written for each stored image type; anything else falls back to `.png`. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * A single safe path segment derived from a view name: no separators, no traversal, no leading
 * dot, and short enough for any filesystem. Everything outside a conservative set collapses to
 * `-`, which is lossy ON PURPOSE: the file name is a HANDLE the agent types back, and the view
 * it stands for is stated beside it in the prompt, so legibility beats fidelity here.
 */
function slugify(view: string): string {
  const slug = view
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'view'
}

/**
 * Name each reference's file, keeping the names UNIQUE within the run.
 *
 * Two different views can slug to one name (`Checkout / step 1` and `Checkout — step 1`), and
 * dropping one of them would hand the agent a directory quietly missing a screen it is being
 * asked to compare. So a collision is suffixed with its ordinal instead, in reference order:
 * deterministic, and the prompt states which view each file is, so the suffix never has to be
 * interpreted.
 */
export function nameReferenceFiles(references: readonly BlockReference[]): ReferenceScreenshot[] {
  const used = new Set<string>()
  return references.map((reference) => {
    const extension = EXTENSIONS[reference.contentType] ?? 'png'
    const base = slugify(reference.view)
    let candidate = `${base}.${extension}`
    for (let n = 2; used.has(candidate); n += 1) candidate = `${base}-${n}.${extension}`
    used.add(candidate)
    return { view: reference.view, artifactId: reference.artifactId, fileName: candidate }
  })
}

/** What {@link resolveReferenceScreenshots} reads through; all of it already on the engine. */
export interface ReferenceScreenshotDeps {
  documents?: DocumentRepository
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  agentKindRegistry: AgentKindRegistry
}

/**
 * Resolve the reference files for a dispatch that CAPTURES views, as a SPREAD-READY partial (the
 * `validationChecksFor` shape), so the hot context builder gains no branch of its own.
 *
 * The gate is the running kind's declared `ui` image, the same fact the executor routes the job
 * by: only a browser-driven kind captures screenshots, and only a capture has a reference to be
 * compared against. It lives HERE rather than at the call site so a deployment's own capturing
 * kind is served by the same rule, and so every other kind never triggers the two reads.
 *
 * ABSENT and EMPTY are different answers and both are reachable: absent means this dispatch never
 * asked (a kind that captures nothing, a deployment with no artifact storage), an empty array
 * means it asked and the task holds no reference at all. A tester with no references names its own
 * views, which is the documented fallback, so neither is a failure.
 */
export async function resolveReferenceScreenshots(
  deps: ReferenceScreenshotDeps,
  agentKind: string,
  workspaceId: string,
  blockId: string,
): Promise<Pick<AgentRunContext, 'referenceScreenshots'>> {
  const resolveStore = deps.resolveBinaryArtifactStore
  if (!resolveStore || deps.agentKindRegistry.agentStep(agentKind)?.image !== 'ui') return {}
  const store: BinaryArtifactStore | null = await resolveStore(workspaceId)
  if (!store) return {}
  const { references } = await resolveBlockReferences(deps.documents, store, workspaceId, blockId)
  return { referenceScreenshots: nameReferenceFiles(references) }
}
