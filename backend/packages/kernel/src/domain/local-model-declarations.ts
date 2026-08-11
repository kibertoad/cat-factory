import { isLocalRunner, knownLocalModel, type LocalModelDeclaration } from '@cat-factory/contracts'
import type { ModelRef } from '../ports/model-provider.js'

// What a user DECLARED about the locally-run models they enabled, and the one rule for folding
// it onto a resolved ref.
//
// Every OTHER model's per-flavour facts (`contextTokens`, `acceptsImages`) come off `MODEL_CATALOG`,
// which is code: `resolveModelRef` finds the entry and the ref it returns already carries them. A
// local model has no entry to find (it lives on one person's machine, and `parseLocalModelId`
// builds its ref out of the ID ALONE), so the ref arrives with every declared fact absent, and
// nothing downstream can tell "this model is text-only" from "this platform never asked".
//
// Two tiers close that gap, and this module owns the precedence between them: the user's own
// DECLARATION for the model, else what contracts' `KNOWN_LOCAL_MODELS` table knows about the family.
// The declaration wins because the person who pulled the weights is the one who knows which build
// they are running; the table is what keeps them from having to say so for Gemma 4.
//
// This is deliberately NOT part of `ProviderCapabilities`: that set answers whether a model may run
// at all (and is built at BOOT from deployment-level facts, with no user in hand), while this
// answers what the model can do once it does. The run path gets the declarations from
// `AgentRunContext.localModelDeclarations`, resolved once per dispatch by the engine from the RUN
// INITIATOR's own endpoints; the picker gets them straight off those endpoints via
// `localSelectableModels`. Both then come through `resolveLocalModelModality` below, so the option
// the settings panel labels and the picture the run attaches cannot disagree.

/** What one stored `models` blob held: the declarations it could read, and whether it lost any. */
export interface ParsedLocalModelDeclarations {
  models: LocalModelDeclaration[]
  /**
   * Whether anything in the blob was REFUSED rather than read: an unparseable blob, a blob that is
   * not an array, or an entry that is not an object with a non-empty string `id`.
   *
   * Reported rather than swallowed because the drop is otherwise indistinguishable from a runner
   * the user never enabled anything on: both render as "0 models" and offer nothing in the picker,
   * and only one of them is fixed by re-ticking. A boolean rather than a count on purpose, because
   * a blob that is not an array at all has no entries left to count and a number there would be a
   * guess presented as evidence.
   */
  unreadable: boolean
}

/**
 * Read the `models` JSON of a stored local-runner endpoint. Lives here, not in each store, because
 * all three (D1, Postgres, the local-sqlite mothership store) must answer a given blob identically
 * or the conformance suite is asserting three separate rules.
 *
 * An entry that is not an object with a non-empty string `id` is DROPPED rather than coerced. That
 * covers a row written before declarations existed, when the column held bare strings: per the
 * internals compatibility rule such state is allowed to break, but it has to break AS a break.
 * `String(entry)` would have produced a declaration for the model id `[object Object]`, and
 * `{ id: undefined }` an entry no picker can render and no run can resolve. Dropping surfaces it
 * where it is fixable, and {@link ParsedLocalModelDeclarations.unreadable} is what carries the
 * drop as far as the panel, so the runner says its models were discarded instead of reading as one
 * nothing was ever enabled on.
 */
export function parseLocalModelDeclarations(json: string): ParsedLocalModelDeclarations {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { models: [], unreadable: true }
  }
  if (!Array.isArray(parsed)) return { models: [], unreadable: true }
  const models: LocalModelDeclaration[] = []
  let unreadable = false
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      unreadable = true
      continue
    }
    const { id, acceptsImages } = entry as { id?: unknown; acceptsImages?: unknown }
    if (typeof id !== 'string' || !id) {
      unreadable = true
      continue
    }
    models.push({ id, ...(typeof acceptsImages === 'boolean' ? { acceptsImages } : {}) })
  }
  return { models, unreadable }
}

/** One runner's enabled models plus what the user declared about each. */
export interface LocalModelDeclarations {
  /** The runner provider id (e.g. `ollama`), which is also the `ModelRef.provider`. */
  provider: string
  models: readonly LocalModelDeclaration[]
}

/**
 * What the user declared about the model a ref names, or undefined when the ref is not a local
 * one, when the runner is not among these, or when the model was not declared.
 */
export function declaredLocalModel(
  ref: Pick<ModelRef, 'provider' | 'model'>,
  declarations: readonly LocalModelDeclarations[] | undefined,
): LocalModelDeclaration | undefined {
  if (!declarations?.length || !isLocalRunner(ref.provider)) return undefined
  // Matched on the runner too, never on the model id alone: two runners can serve the same model
  // id (the whole point of `"<provider>:<model>"` being the catalog id), and they need not agree
  // about it, one being an image-capable build and the other not.
  return declarations
    .find((d) => d.provider === ref.provider)
    ?.models.find((m) => m.id === ref.model)
}

/**
 * Whether a locally-run model accepts image input: what the USER declared for it, else what the
 * recognised-family table knows, else undefined for "nobody has said".
 *
 * The ONE place that precedence lives, called by both readers (the run's fold below and the picker's
 * `localSelectableModels`). Undefined is a real answer and must be passed through as one, never
 * defaulted to `false`.
 */
export function resolveLocalModelModality(
  modelId: string,
  declared: LocalModelDeclaration | undefined,
): boolean | undefined {
  return declared?.acceptsImages ?? knownLocalModel(modelId)?.acceptsImages
}

/**
 * Fold what is known about a LOCAL model's modality onto its resolved ref, so the dispatch sites
 * read it off the ref exactly as they do for a catalog model.
 *
 * A non-local ref, and a local one nothing has an answer for, return the ref UNCHANGED rather than
 * stamping a `false`: absent is a real third answer here (see `localModelDeclarationSchema`), and it
 * is what makes `resolveDesignImageDelivery` report `unknown_model_image_input` instead of claiming
 * the model cannot read pictures.
 *
 * NO declarations at all is that same absent answer, and the recognised-family table is NOT
 * consulted for it. "The initiator declared nothing about this model" and "nobody resolved any
 * declarations for this dispatch" are different facts: the second is what a run with no initiator
 * (a schedule, a system sweep) or a deployment with no runner store produces, and it means the
 * user's own `false` is exactly what could not be read. Letting the table answer over an unread
 * declaration would attach pictures to a build its owner marked text-only, which is the one
 * outcome the escape hatch exists to prevent.
 */
export function withLocalModelDeclaration(
  ref: ModelRef,
  declarations: readonly LocalModelDeclarations[] | undefined,
): ModelRef {
  if (!declarations?.length || !isLocalRunner(ref.provider)) return ref
  const acceptsImages = resolveLocalModelModality(ref.model, declaredLocalModel(ref, declarations))
  if (acceptsImages === undefined) return ref
  return { ...ref, acceptsImages }
}
