import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The CONTENT-TYPE vocabulary shared by the two halves of a binary-output step: what a registered
// generative integration PRODUCES (`binary-generators.ts`) and what a step's stored artifacts
// turned out to BE (`binary-outputs.ts`).
//
// Its own leaf module — no imports beyond valibot — because both of those modules need it and one
// of them sits downstream of the entity schemas the other is reached through. A vocabulary this
// small has no business creating an import cycle.
// ---------------------------------------------------------------------------

/**
 * The CONTENT TYPE a generative integration produces, as a closed vocabulary.
 *
 * Closed, unlike the free-form capability tags on a foundational service, because this one is
 * the platform's own: it decides which generator a step may be given for which deliverable, it
 * groups the agent-facing brief, and the SPA renders a picker off it. A free-form tag would
 * make `images` and `image` two different content types that look identical to a reader and
 * silently fail to match — the exact failure `reservedCapabilityNearMiss` exists to catch for
 * the tags that genuinely must stay free-form.
 *
 * The members are MODALITIES, not genres: music, speech and sound effects are all `audio`,
 * because what differs between them is the prompt, while what differs between audio and video
 * is the whole integration, its media types and what a step can do with the result. A
 * deployment that must tell a music generator from a speech generator says so in the
 * definition's `mediaTypes` and its description.
 */
export const binaryModalitySchema = v.picklist([
  /** Still images — `image/png`, `image/webp`, `image/jpeg`, `image/svg+xml`. */
  'image',
  /** Anything heard: music, speech/voice-over, sound effects — `audio/mpeg`, `audio/wav`. */
  'audio',
  /** Moving pictures, with or without an audio track — `video/mp4`, `video/webm`. */
  'video',
  /** 3D geometry — `model/gltf-binary`, `model/obj`. */
  '3d',
  /** A rendered, paginated document — `application/pdf`. */
  'document',
])
export type BinaryModality = v.InferOutput<typeof binaryModalitySchema>

/**
 * The {@link BinaryModality} a media type belongs to, or `null` when nothing here recognises it.
 *
 * `null` is a REAL answer and callers must keep it apart from a modality: it means the platform
 * does not know what this content is, which is different from knowing it is not an image. It is
 * what lets a registration's declared media types be checked against its declared modalities
 * (a generator claiming `audio` while listing `image/png` is a configuration error, not a
 * judgement call) and what lets a settled step's declared artifacts be CLASSIFIED in code rather
 * than by asking the model what kind of thing it just made.
 */
export function modalityOfMediaType(value: string): BinaryModality | null {
  const type = normalizeMediaType(value) ?? ''
  const [top, subtype] = type.split('/')
  if (!top || !subtype) return null
  if (top === 'image') return 'image'
  if (top === 'audio') return 'audio'
  if (top === 'video') return 'video'
  if (top === 'model') return '3d'
  if (top === 'application') {
    if (subtype === 'pdf') return 'document'
    // The 3D formats that predate `model/*` and are still what tooling emits: `sla` is STL, and
    // `x-tgif` is what the shared mime database maps `.obj` to (an old collision with the TGIF
    // drawing format, but it IS the type an OBJ file is served as, so recognising it is right).
    // `octet-stream` stays null on purpose — it is the "no idea" type, and guessing `3d` from it
    // would classify every unlabelled download as a model.
    if (subtype === 'octet-stream') return null
    // `x-blender` is the shared mime database's type for a `.blend` file, which is what an
    // EDITABLE 3D deliverable looks like when the consumer is an artist rather than an engine —
    // the same reason `sla` and `x-tgif` are here rather than only the registered `model/*` names.
    if (['gltf+json', 'x-gltf', 'sla', 'x-tgif', 'x-blender'].includes(subtype)) return '3d'
    return null
  }
  return null
}

/**
 * A media type reduced to the `type/subtype` two people mean the same thing by — lowercased,
 * trimmed, parameters dropped — or `null` when there is no `type/subtype` in it at all.
 *
 * The ONE definition of "the same format", because three places compare media types and two of
 * them receive text nobody normalised. A step's declared formats and a generator's declared
 * formats both come through {@link mediaTypeSchema}, which already lowercases and refuses
 * parameters, so those two match on plain equality; a SETTLED artifact's `contentType` is the
 * agent's own prose (`image/PNG`, `model/gltf-binary; charset=binary`) and matches nothing until
 * it comes through here. A second copy of this reduction is how `model/GLTF-binary` becomes a
 * format the platform reports as undelivered while the file sits exactly where it was asked for.
 *
 * Note what it deliberately does NOT do: it maps no synonyms. `model/obj` and
 * `application/x-tgif` are the same file and stay different values here, because a step's format
 * requirement is checked by EXACT match against what a generator declared, and a matcher that
 * quietly accepted a near-neighbour would admit a GLB where an OBJ was required — which is the
 * failure the requirement exists to prevent. The two sides agree by spelling the format the same
 * way, and the brief tells the agent the exact string.
 */
export function normalizeMediaType(value: string): string | null {
  const type = value.trim().toLowerCase().split(';')[0]?.trim() ?? ''
  const [top, subtype] = type.split('/')
  return top && subtype ? `${top}/${subtype}` : null
}

/**
 * A media type as `type/subtype` (parameters are NOT accepted — a generator declares what it
 * produces, not how one request happened to be encoded).
 */
export const mediaTypeSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.minLength(3),
  v.maxLength(128),
  v.regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
    'must be a media type of the form type/subtype',
  ),
)
