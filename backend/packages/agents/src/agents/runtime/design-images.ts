import type {
  AgentRunContext,
  DesignImageDelivery,
  DesignImageSet,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The INLINE half of design-picture delivery: turning the set the engine resolved into the image
// content parts an inline model call carries.
//
// The container half needs nothing like this — the harness downloads the bytes into the checkout
// and the CLI reads them — which is why the bytes are fetched HERE, at the one call site that has
// to put them in a request. Loading them any earlier would mean megabytes of PNG on an
// `AgentRunContext` that is snapshotted, and on a job body that is persisted with its dispatch.
// ---------------------------------------------------------------------------

/** One picture, loaded and ready to become an image content part. */
export interface LoadedDesignImage {
  view: string
  mediaType: string
  data: Uint8Array
}

/** What {@link loadDesignImages} produced: what it has, and the views it could not fetch. */
export interface LoadedDesignImages {
  images: LoadedDesignImage[]
  /** Views whose bytes did not come back. Empty when everything loaded. */
  missing: string[]
}

/**
 * Fetch the bytes for a dispatch's design pictures.
 *
 * Sequential rather than fanned out: the set is capped at a handful, and this runs on the critical
 * path of one model call against a shared blob backend, so a fan-out would buy milliseconds and
 * spend them on a burst nobody asked for.
 *
 * A picture whose bytes are gone is DROPPED and named, never substituted: the store can hold a row
 * whose blob the backend has lost, and an image part with no bytes is a failed request rather than
 * a degraded one.
 */
export async function loadDesignImages(
  resolveStore: ResolveBinaryArtifactStore,
  workspaceId: string,
  set: DesignImageSet,
): Promise<LoadedDesignImages> {
  const store = await resolveStore(workspaceId)
  if (!store) return { images: [], missing: set.files.map((file) => file.view) }
  const images: LoadedDesignImage[] = []
  const missing: string[] = []
  for (const file of set.files) {
    const blob = await store.getBlob(workspaceId, file.artifactId)
    if (!blob?.byteLength) {
      missing.push(file.view)
      continue
    }
    images.push({ view: file.view, mediaType: file.contentType, data: blob })
  }
  return { images, missing }
}

/**
 * Fold a load outcome back into the context the prompt is rendered from.
 *
 * The prompt section names the views it was handed, so a view whose bytes never arrived has to
 * leave the FILE list and join `omitted` — otherwise the agent is told to look at a picture that is
 * not in the message, which reads to it as its own failure to find something. `omitted` states no
 * cause for exactly this reason: a capped view and a lost one are the same instruction to an agent
 * (work from the text), and the difference is an operator's question, answered by the log.
 *
 * A set that loaded NOTHING settles as `transfer_failed` rather than as an empty attachment: those
 * are opposite facts, and only the first sends anyone to look at the store.
 */
export function foldLoadedDesignImages(
  set: DesignImageSet,
  loaded: LoadedDesignImages,
  attached: DesignImageDelivery,
): Pick<AgentRunContext, 'designImages' | 'designImageDelivery'> {
  if (!loaded.images.length) {
    return {
      designImages: set,
      designImageDelivery: { attached: false, reason: 'transfer_failed' },
    }
  }
  const shown = new Set(loaded.images.map((image) => image.view))
  return {
    designImages: {
      files: set.files.filter((file) => shown.has(file.view)),
      omitted: [...set.omitted, ...loaded.missing],
    },
    designImageDelivery: attached,
  }
}
