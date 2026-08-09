import type { HarnessKind, ModelRef } from '../ports/model-provider.js'

// ---------------------------------------------------------------------------
// Whether a dispatch can put a design RENDER in front of its model, and the reason when it
// cannot.
//
// The platform holds pictures of a task's linked designs (the frames an import retained, plus the
// images a person attached), and until now they reached a model on no path at all: a container
// agent got the textual `.cat-context/` description and an explicit instruction NOT to fetch the
// preview URL, and an inline caller got the same text. What a designer actually cares about, what
// the screen looks like, was invisible to every agent building it.
//
// Delivery is a PAIR fact, and both halves have to be true: the harness must have a way to put an
// image into a turn, and the model must accept one. Neither half implies the other, so they are
// declared separately and joined here, once, rather than re-derived at each delivery site.
// ---------------------------------------------------------------------------

/**
 * Which harnesses can put an IMAGE in front of their model, as an exhaustive `Record` over
 * `HarnessKind` so a new harness cannot be added without stating its answer (an omitted entry
 * would read as `false` and silently drop every render on that harness).
 *
 * `false` is a statement about THIS repo's pinned CLI, not a claim about the vendor's product. The
 * bar for `true` is that the image has a verified way to get bytes into a turn, because the cost of
 * guessing is asymmetric: a harness wrongly marked `true` is handed a manifest, downloads the
 * frames, tells the agent they are there, and the agent then reports it cannot see them, which
 * reads to everyone as a platform bug rather than as a missing capability. A harness wrongly marked
 * `false` costs a run the pictures and SAYS SO, which is the disposition the whole vocabulary
 * below exists to give.
 *
 * - `claude-code` reads an image file with its own file-reading tool, which is why the container
 *   half of this feature is files on disk plus a prompt that names them: the CLI composes the
 *   image content part, exactly as it does for a screenshot a human pastes at it.
 * - `codex` and `pi` are `false` today. Codex's pinned CLI has no verified file-to-turn path in
 *   this image, and Pi has no image input at all (the same reason it has no MCP client). Flip an
 *   entry here in the change that teaches the image to carry the bytes, never ahead of it.
 */
export const HARNESS_IMAGE_INPUT: Record<HarnessKind, boolean> = {
  pi: false,
  'claude-code': true,
  codex: false,
}

/**
 * Whether this harness can put an image in front of its model. An INLINE call (no harness) passes
 * `undefined` and is always able to: the caller composes the model message itself, so there is no
 * CLI in between and the model half is the only question left.
 */
export function harnessAcceptsImages(harness: HarnessKind | undefined): boolean {
  return harness === undefined ? true : HARNESS_IMAGE_INPUT[harness]
}

/**
 * Why a run's design renders were NOT put in front of its model.
 *
 * Each member names a DIFFERENT fix, which is why they are not folded into one "unavailable":
 *
 * - `harness_no_image_input` is the CLI: this kind runs in a container on a harness with no way to
 *   read an image into a turn. Switching the step's model to another image-capable one changes
 *   nothing; the fix is a different harness (or an image that teaches this one).
 * - `model_no_image_input` is the model: the harness could carry an image and the resolved model
 *   does not take one. Here the fix IS the model, which is why it must not read as the harness's
 *   limitation.
 * - `unknown_model_image_input` is the honest third answer, and the commonest: the catalog does not
 *   declare whether this flavour accepts images. It is kept apart from `model_no_image_input`
 *   because they send a reader to opposite places (declare the capability, versus pick a different
 *   model), and collapsing them would let an undeclared multimodal model read as a text-only one
 *   forever, with nothing anywhere saying the platform simply never asked.
 * - `transfer_failed` is the store: the pair CAN carry an image and the bytes did not arrive. The
 *   only transient member, and the only one worth retrying.
 *
 * There is deliberately no member for "the task has no design": that is an absent set, not a
 * refused delivery, and a run with nothing to show must not tell its agent that something was
 * withheld.
 */
export type DesignImageUnavailableReason =
  | 'harness_no_image_input'
  | 'model_no_image_input'
  | 'unknown_model_image_input'
  | 'transfer_failed'

/**
 * HOW the pictures reached the model, when they did.
 *
 * Carried rather than re-derived at each prompt site, because the two channels put the images in
 * different places and a prompt that names the wrong one is worse than one that names neither: a
 * container agent told its designs are "attached below" goes looking through a message that has
 * none, and an inline model pointed at a checkout directory has no filesystem to look in.
 *
 * - `files` — the harness wrote them into the checkout and the CLI reads them with its own
 *   image-reading tool, which is what composes the image content part.
 * - `message` — the caller put them in the model request itself, as image parts (an inline call:
 *   there is no CLI in between and no disk to write to).
 */
export type DesignImageChannel = 'files' | 'message'

/**
 * What a dispatch decided about its renders: a discriminated result rather than a nullable one, so
 * "not attached" always arrives WITH its cause and the prompt can state it.
 */
export type DesignImageDelivery =
  | { attached: true; channel: DesignImageChannel }
  | { attached: false; reason: DesignImageUnavailableReason }

/**
 * Join the two halves for one dispatch: the harness's ability to carry an image and the resolved
 * model's ability to take one.
 *
 * The harness is asked FIRST, and the order is load-bearing rather than stylistic. A subscription
 * harness pins its own model, so a Codex run reporting `model_no_image_input` would send someone to
 * change a model they cannot change without also changing the harness; the CLI is the outer
 * constraint and the honest one to name.
 *
 * `acceptsImages` is a tri-state on purpose (see {@link DesignImageUnavailableReason}): `true`
 * attaches, `false` refuses as the model's limitation, and ABSENT refuses as the platform's own
 * silence about this flavour.
 */
export function resolveDesignImageDelivery(
  harness: HarnessKind | undefined,
  ref: Pick<ModelRef, 'acceptsImages'>,
): DesignImageDelivery {
  if (!harnessAcceptsImages(harness)) {
    return { attached: false, reason: 'harness_no_image_input' }
  }
  if (ref.acceptsImages === undefined) {
    return { attached: false, reason: 'unknown_model_image_input' }
  }
  if (!ref.acceptsImages) return { attached: false, reason: 'model_no_image_input' }
  // The channel follows from the same fact that decided the harness half: a harness means a CLI
  // reading a checkout, and no harness means the caller composes the message itself.
  return { attached: true, channel: harness === undefined ? 'message' : 'files' }
}
