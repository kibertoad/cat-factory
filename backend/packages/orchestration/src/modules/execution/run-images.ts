import type {
  AgentRunContext,
  BinaryArtifactStore,
  DesignImage,
  DocumentRepository,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { DESIGN_IMAGES_TRAIT, hasTrait } from '@cat-factory/agents'
import { resolveBlockReferences } from './block-reference-set.js'
import type { BlockReference } from './block-reference-set.js'
import {
  MAX_REFERENCE_SCREENSHOTS,
  assignFileNames,
  capReferences,
  nameReferenceFiles,
} from './run-reference-screenshots.js'
import { MAX_DESIGN_IMAGES } from './run-design-images.js'

// ---------------------------------------------------------------------------
// The images a dispatch is handed, from the ONE read of the task's reference set.
//
// A task's pictures have two consumers with opposite jobs: a CAPTURING kind reads them to name and
// compare its own screenshots against, and a BUILDING kind is meant to look at them. Both draw from
// the same set (an import's retained frames plus a person's uploads) and both name their files with
// the same rule, so they are resolved together here rather than side by side: a kind that did both
// would otherwise read the documents and the artifact store twice per dispatch, and the two answers
// could disagree about a view name, which is the exact join the visual-confirmation gate performs.
//
// What each consumer decides for itself stays in its own module: the ceiling and the disposition of
// what is dropped (`run-reference-screenshots.ts`, `run-design-images.ts`).
// ---------------------------------------------------------------------------

/** What {@link resolveRunImages} reads through; all of it already on the engine. */
export interface RunImageDeps {
  documents?: DocumentRepository
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  agentKindRegistry: AgentKindRegistry
}

/** The two image partials, spread-ready (the `validationChecksFor` shape). */
type RunImages = Pick<AgentRunContext, 'referenceScreenshots' | 'designImages'>

/**
 * Resolve this dispatch's images, as a SPREAD-READY partial so the hot context builder gains no
 * branch of its own.
 *
 * Each half is gated on what the KIND declares, and a kind declaring neither costs nothing: the
 * store and document reads happen only once at least one consumer wants them.
 *
 * - The capture set is gated on the kind's declared `ui` image, the same fact the executor routes
 *   the job by, so a deployment's own browser-driven kind is served by the same rule.
 * - The design set is gated on the `design-images` trait, for the same reason.
 *
 * The two halves answer an EMPTY set differently, deliberately. A capture that asked and found
 * nothing still tells a tester so ("you were asked, and there is nothing to compare against"); a
 * building kind with no pictures is just a task that links no design, which is the ordinary state
 * of most tasks and nothing a prompt should spend a line on.
 */
export async function resolveRunImages(
  deps: RunImageDeps,
  agentKind: string,
  workspaceId: string,
  blockId: string,
): Promise<RunImages> {
  const captures = deps.agentKindRegistry.agentStep(agentKind)?.image === 'ui'
  const builds = hasTrait(agentKind, DESIGN_IMAGES_TRAIT, deps.agentKindRegistry)
  const resolveStore = deps.resolveBinaryArtifactStore
  if (!resolveStore || (!captures && !builds)) return {}
  const store: BinaryArtifactStore | null = await resolveStore(workspaceId)
  if (!store) return {}
  const { references } = await resolveBlockReferences(deps.documents, store, workspaceId, blockId)
  return {
    ...(captures ? captureSet(references) : {}),
    ...(builds ? designSet(references) : {}),
  }
}

/** The capture half: named files plus the views the cap dropped, empty set included. */
function captureSet(
  references: readonly BlockReference[],
): Pick<RunImages, 'referenceScreenshots'> {
  const { kept, omitted } = capReferences(references, MAX_REFERENCE_SCREENSHOTS)
  return { referenceScreenshots: { files: nameReferenceFiles(kept), omitted } }
}

/** The design half: nothing at all when the task holds no picture (see {@link resolveRunImages}). */
function designSet(references: readonly BlockReference[]): Pick<RunImages, 'designImages'> {
  if (!references.length) return {}
  const { kept, omitted } = capReferences(references, MAX_DESIGN_IMAGES)
  const names = assignFileNames(kept)
  const files: DesignImage[] = kept.map((reference, index) => ({
    view: reference.view,
    artifactId: reference.artifactId,
    contentType: reference.contentType,
    fileName: names[index]!,
  }))
  return { designImages: { files, omitted } }
}
