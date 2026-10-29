import type {
  DesignImageDelivery,
  DesignImageSet,
  ModelRef,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import { resolveDesignImageDelivery } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The INLINE half of image delivery (a task's design pictures and the images attached to it):
// turning a set the engine resolved into the image content parts an inline model call carries.
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

/** A set and the verdict on it, after a load: what an inline call's prompt is rendered from. */
export interface InlineImageOutcome {
  set: DesignImageSet
  delivery: DesignImageDelivery
}

/**
 * Fold a load outcome back into the set the prompt is rendered from.
 *
 * The prompt section names the views it was handed, so a view whose bytes never arrived has to
 * leave the FILE list and join `omitted`: otherwise the agent is told to look at a picture that is
 * not in the message, which reads to it as its own failure to find something. `omitted` states no
 * cause for exactly this reason: a capped view and a lost one are the same instruction to an agent
 * (work from the text), and the difference is an operator's question, answered by the log.
 *
 * A set that loaded NOTHING settles as `transfer_failed` rather than as an empty attachment: those
 * are opposite facts, and only the first sends anyone to look at the store.
 */
export function foldLoadedImages(
  set: DesignImageSet,
  loaded: LoadedDesignImages,
  attached: DesignImageDelivery,
): InlineImageOutcome {
  if (!loaded.images.length) {
    return { set, delivery: { attached: false, reason: 'transfer_failed' } }
  }
  const shown = new Set(loaded.images.map((image) => image.view))
  return {
    set: {
      files: set.files.filter((file) => shown.has(file.view)),
      omitted: [...set.omitted, ...loaded.missing],
    },
    delivery: attached,
  }
}

/**
 * Settle what one inline model call can do with an image set, and load the bytes when it can carry
 * them. Shared by every inline caller (the agent executor and the inline review services), so the
 * verdict and the transfer-failure rule cannot differ between them.
 *
 * `textOnly` is the ambient inline path: a deployment serving the ref by driving its CLI as a host
 * subprocess flattens the request to text, so an image part would be dropped on the way out.
 */
export async function prepareInlineImages(args: {
  set: DesignImageSet | undefined
  ref: Pick<ModelRef, 'acceptsImages'>
  textOnly: boolean
  resolveStore: ResolveBinaryArtifactStore | undefined
  workspaceId: string | undefined
}): Promise<{ outcome?: InlineImageOutcome; images: LoadedDesignImage[] }> {
  const { set } = args
  if (!set?.files.length) return { images: [] }
  const delivery: DesignImageDelivery = args.textOnly
    ? { attached: false, reason: 'inline_harness_text_only' }
    : resolveDesignImageDelivery({ channel: 'message' }, args.ref)
  if (!delivery.attached) return { outcome: { set, delivery }, images: [] }
  if (!args.resolveStore || !args.workspaceId) {
    // A set exists and this caller has no way to read its bytes: reported as the transfer failure
    // it is, never as an attachment of nothing.
    return {
      outcome: { set, delivery: { attached: false, reason: 'transfer_failed' } },
      images: [],
    }
  }
  const loaded = await loadDesignImages(args.resolveStore, args.workspaceId, set)
  return { outcome: foldLoadedImages(set, loaded, delivery), images: loaded.images }
}

/** The image content parts an inline request carries, in the order the prompt names them. */
export function imageParts(images: readonly LoadedDesignImage[]) {
  return images.map((image) => ({
    type: 'image' as const,
    image: image.data,
    mediaType: image.mediaType,
  }))
}
