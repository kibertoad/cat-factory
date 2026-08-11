// ---------------------------------------------------------------------------
// What the platform KNOWS about the popular locally-run model families, so the common
// case needs no declaration from the user.
//
// A local model has no `MODEL_CATALOG` entry: it lives on one person's machine, the runner's
// OpenAI-compatible `/models` probe returns ids and nothing else, and the id itself is free
// text. That is why `LocalModelDeclaration` exists. But most people run a handful of
// well-known open-weights families, and asking each of them to hand-declare that Gemma 4
// reads images is asking them to re-supply a fact this repo can simply carry.
//
// So there are two tiers, and the ESCAPE HATCH OUT-RANKS the table: a user's own declaration
// always wins, because they are the one who knows which build they pulled (a text-only quant,
// a fine-tune, a re-tagged local copy). This table only answers when they have said nothing.
//
// Lives in contracts, not kernel, because BOTH sides must agree about it: the SPA labels the
// "not set" option with what the table will do, and the engine folds the same answer onto the
// dispatched ref. A copy on either side would let the settings panel promise a model images
// that the run then withholds.
// ---------------------------------------------------------------------------

/** One recognised local model family and what its weights can be given. */
export interface KnownLocalModel {
  /** Stable family key, for tests and for anything that wants to group by family. */
  family: string
  /** Display name, shown to the user beside the modality it implies. */
  label: string
  /**
   * Id fragments that identify the family, ALREADY SQUASHED the way {@link squashModelId}
   * squashes a runner's id (lowercase, alphanumerics only), and matched as substrings. That is
   * what lets one entry cover every shape the ecosystem serves the same weights under:
   * `gemma4:12b` (Ollama), `google/gemma-4-12b` (LM Studio), `Gemma-4-12B-it-GGUF` (llama.cpp),
   * `mlx-community/Gemma-4-12B-4bit` (MLX).
   */
  match: readonly string[]
  /**
   * Whether the family's weights accept IMAGE input.
   *
   * Every entry today says `true`, and that is a rule rather than a coincidence: an entry earns
   * its place only where the platform's SILENCE would cost a capability. A text-only model
   * behaves identically whether this table calls it `false` or says nothing — both withhold the
   * run's design renders — so listing one would add a maintenance surface, and a wrong `false`
   * would silently withhold pictures from a model that could have read them. The field is
   * explicit anyway so a future entry that genuinely needs to correct an assumption can.
   */
  acceptsImages: boolean
}

/**
 * The recognised families. Each is here because its publisher documents image input for the
 * open weights, verified against that publisher's own release material rather than inferred
 * from a family resemblance.
 *
 * A family whose modality depends on the SIZE is deliberately ABSENT rather than approximated:
 * Gemma 3 is the worked example (its 1B is text-only while its 4B and up are not), and an entry
 * matching the family name would have told every `gemma3:1b` user their model reads images. When
 * in doubt, leave it out — the user's own declaration is right there, and an absence self-corrects
 * where a wrong entry does not.
 */
export const KNOWN_LOCAL_MODELS: readonly KnownLocalModel[] = [
  {
    family: 'muse-glimmer',
    label: 'Muse Glimmer',
    // Meta's 30B agentic model: a dedicated perception encoder, interleaved text and images.
    match: ['museglimmer'],
    acceptsImages: true,
  },
  {
    family: 'gemma4',
    label: 'Gemma 4',
    // Google ships native vision in EVERY Gemma 4 variant, 2B through 31B, which is what makes
    // the bare family name safe to match here where `gemma3` is not.
    match: ['gemma4'],
    acceptsImages: true,
  },
  {
    family: 'qwen-vl',
    label: 'Qwen (VL)',
    // Qwen's vision-language line, which is EXPLICIT in the id. The plain `qwen3.6` / `qwen3`
    // builds are left unrecognised on purpose: the series is described as multimodal while
    // vision is delivered by the `-VL` variants, and that ambiguity is not something to resolve
    // by guessing on a user's behalf.
    match: ['qwenvl', 'qwen2vl', 'qwen25vl', 'qwen3vl', 'qwen35vl', 'qwen36vl'],
    acceptsImages: true,
  },
  {
    family: 'llama4',
    label: 'Llama 4',
    // Natively multimodal across Scout and Maverick; the same fact `MODEL_CATALOG` already
    // declares for the Workers AI flavour of Scout.
    match: ['llama4'],
    acceptsImages: true,
  },
  {
    family: 'llava',
    label: 'LLaVA',
    match: ['llava'],
    acceptsImages: true,
  },
  {
    family: 'minicpm-v',
    label: 'MiniCPM-V',
    match: ['minicpmv'],
    acceptsImages: true,
  },
  {
    family: 'moondream',
    label: 'Moondream',
    match: ['moondream'],
    acceptsImages: true,
  },
]

/**
 * Reduce a runner-reported model id to its comparable core: the last path segment, lowercased,
 * with every non-alphanumeric character removed.
 *
 * One squash rather than a set of per-runner regexes, because the SAME weights arrive under
 * wildly different spellings and the differences are all punctuation and packaging: an org
 * prefix (`google/`), a size tag (`:12b`), a quantisation suffix (`-q4_k_m`), a format
 * (`-gguf`, `-mlx`, `.gguf`), a hyphen where another registry uses none. Squashing both sides
 * and testing for a substring absorbs all of it, and it keeps VERSION digits significant, which
 * is what stops a `gemma4` entry from claiming a `gemma3` id.
 */
export function squashModelId(id: string): string {
  const segment = id.split('/').pop() ?? id
  return segment.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The recognised family for a runner-reported model id, or undefined when the platform knows
 * nothing about it (the normal case for a fine-tune or a private build).
 *
 * Callers must treat undefined as "nobody has said", NEVER as "text only": that distinction is
 * the whole reason `LocalModelDeclaration.acceptsImages` is three-state.
 */
export function knownLocalModel(id: string | undefined | null): KnownLocalModel | undefined {
  if (!id) return undefined
  const squashed = squashModelId(id)
  if (!squashed) return undefined
  return KNOWN_LOCAL_MODELS.find((known) => known.match.some((m) => squashed.includes(m)))
}
