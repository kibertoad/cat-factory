import { NANO_BANANA_GENERATOR_ID } from '@cat-factory/contracts'
import { NANO_BANANA_OPENAPI } from '../contracts/nano-banana.openapi.js'
import { defineBinaryGenerator, openApiContract } from '../define.js'

/**
 * The environment variable the Gemini API key is delivered as.
 *
 * Both what the deployment's `ToolSecretResolver` is asked for and the variable name the agent
 * reads inside its run container, which is why it is a POSIX identifier rather than the header it
 * ends up in (`x-goog-api-key`).
 *
 * Named for the VENDOR rather than for this definition's id: `GEMINI_API_KEY` is the variable
 * Google's own `google-genai` client libraries read from the environment, so an agent that reaches
 * for a library instead of writing the request by hand finds the value where the library looks.
 * That is also why this definition needs no `envName`: the lookup key and the injected name are
 * already the same string.
 *
 * It sits outside `isReservedPlatformEnvKey`'s set, which the tests assert rather than assume. The
 * platform's own Google models are reached through OpenRouter (`OPENROUTER_*`), so no family here
 * covers this name; if one ever does, the lookup resolves nothing and "no credential" looks exactly
 * like an unset variable. Never document it in `docs/environment-variables.md` either: every
 * variable named there is reserved by `check-reserved-env-keys.mjs`, which would retire this key.
 *
 * A workspace sets it as a capability credential (`binary-generator` subject, key `GEMINI_API_KEY`)
 * or the deployment sets it in the environment its runs dispatch from.
 */
export const NANO_BANANA_CREDENTIAL_KEY = 'GEMINI_API_KEY'

/**
 * The registry id a step names in `stepOptions.binaryOutput.generatorIds`, re-exported from
 * `@cat-factory/contracts` rather than spelled here.
 *
 * The id has two authors that must agree: this definition, and the built-in `pl_media` preset in
 * kernel's seed catalog, which selects it. Kernel cannot import this package (this package depends
 * on kernel), so the shared layer below both owns the string and each side reads it.
 */
export { NANO_BANANA_GENERATOR_ID } from '@cat-factory/contracts'

/**
 * `nano-banana`: Google's Gemini image models, and the platform's FIRST shipped generative binary
 * integration.
 *
 * Three facts about where it sits.
 *
 * **It is the only one the platform ships**, which is a change of position rather than a first
 * step down a list. The registry stayed empty on the argument that no image generator is one every
 * organisation runs and every one of them is metered. Both halves are still true and neither one
 * decides this: what shipping the Media task type showed is that a step selecting NOTHING leaves
 * the deployment's most demonstrable capability reachable only by a deployment that first writes
 * an integration, an OpenAPI document and a credential declaration. Metered is handled by the
 * credential (unset means the agent is told the integration is unavailable and reports the gap),
 * so the cost of shipping one is a picker entry a deployment can ignore, against a task type that
 * generates nothing out of the box.
 *
 * **It is SYNCHRONOUS**, which is unusual for this class of API and is most of what its guidance
 * spends its words on. No task id, no polling loop, no signed URL with minutes on it: the bytes
 * come back on the create call. The failure mode that replaces them is quieter than any of those,
 * because a refused prompt answers 200 with text and no image at all.
 *
 * **It emits `image/png` and `image/jpeg`**, the two values `response_format.mime_type` takes and
 * the whole of what this API returns. A step needing a vector or an animated GIF is refused for
 * holding this alone, correctly, and pointed at whatever the deployment registered beside it.
 *
 * @see https://ai.google.dev/gemini-api/docs/image-generation
 */
export const nanoBananaGenerator = defineBinaryGenerator({
  id: NANO_BANANA_GENERATOR_ID,
  name: 'Nano Banana',
  summary:
    'Google’s Gemini image models: conversational generation and reference-guided editing up to 4K, with strong in-image text rendering, returned synchronously as inline bytes and charged per image.',
  modalities: ['image'],
  // The two values `response_format.mime_type` takes. Declare only what a step may REQUIRE: both
  // of these can be asked for by name, so both are safe to state. An integration whose container
  // is whatever the response happens to carry declares the one it always produces and no more.
  mediaTypes: ['image/png', 'image/jpeg'],
  // What a step may ASK this integration for. One operation carries all of it, where most image
  // APIs split the same work across two calls or lack a piece of it.
  //
  //  - `reference-image` / `multi-reference`: `image` blocks in `input`, up to fourteen on one
  //    request.
  //  - `instruction-edit`: the same operation, an `image` block plus a `text` block saying what to
  //    change. Editing is not a separate endpoint here, which is what makes "the same character,
  //    now facing left" a request rather than a re-roll.
  //  - `seed`: `generation_config.seed`.
  //  - `aspect-ratio`: `response_format.aspect_ratio`, a CLOSED list of ten, stated as an `accepts`
  //    set below so a ratio outside it is refused by name rather than generated at the nearest one
  //    and silently cropped.
  //
  // Absent, and each for a reason the endpoint states rather than a preference:
  //
  //  - `mask-edit`: no mask parameter. Conversational editing rewrites the whole picture, which is
  //    a different act from repainting a named region.
  //  - `negative-prompt`: no such field; what to keep out goes in the brief.
  //  - `candidate-batch`: one interaction returns one image. Several candidates are several
  //    requests, each charged, which is what the comparison surface does with it.
  //  - `exact-size`: `image_size` is a resolution LADDER (`512px`, `1K`, `2K`, `4K`) rather than a
  //    width and a height, so this endpoint cannot be handed dimensions at all. A step needing
  //    96x96 is refused here rather than served a 1K render downscaled by whoever wrote the call.
  //  - `upscale`: the same ladder, for the same reason: it is not a multiple of a native size.
  //  - `transparent-background`: PNG is offered, alpha is not a request parameter.
  //  - `tileable`: no parameter.
  capabilities: ['reference-image', 'multi-reference', 'instruction-edit', 'seed', 'aspect-ratio'],
  // The enum is declared VERBATIM rather than pre-reduced, and `21:9` is why that is safe: it
  // reduces to `7:3`, the platform compares in lowest terms at both ends, so a step asking for
  // `7:3` is served. Reducing the set by hand would gain nothing and lose the correspondence to the
  // document beside it, which is what the tests check.
  //
  // No `outputSizes` beside it, deliberately: this endpoint takes no dimensions, so it declares
  // neither `exact-size` nor a size set.
  accepts: {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  },
  endpoint: 'https://generativelanguage.googleapis.com',
  credentials: [
    {
      key: NANO_BANANA_CREDENTIAL_KEY,
      usage: 'x-goog-api-key: <value> (an API key from Google AI Studio)',
      required: true,
    },
  ],
  contracts: [
    openApiContract({
      contractId: 'nano-banana-api',
      title: 'Gemini Interactions API (Nano Banana image generation and editing)',
      document: NANO_BANANA_OPENAPI,
    }),
  ],
  description: `Generates and EDITS images from a written brief and up to fourteen reference images, and hands the bytes back on the same call. Two things make it worth reaching for: it renders long, legible text inside a picture better than most image APIs (signage, UI mockups, labelled diagrams, a title card that has to say the actual title), and it edits conversationally, so "the same character, now facing left, keep the armour" is a request rather than a re-roll.

## Which model

| Model | Resolutions | ~Cost / image | Use it for |
| --- | --- | --- | --- |
| **\`gemini-3.1-flash-lite-image\`** | 1K only | $0.034 | Drafting and thumbnails, where several cheap tries beat one considered one. |
| **\`gemini-3.1-flash-image\`** | 512px, 1K, 2K, 4K | $0.045-0.151 | The default. Everything that is not specifically a typography or identity problem. |
| **\`gemini-3-pro-image\`** | 1K, 2K, 4K | $0.134-0.24 | The image you keep when it has words in it, or when a character has to survive into a set. |

Cost is per IMAGE and rises with resolution, so the size is the budget. \`image_size\` is a closed set of four strings rather than a pixel count, so a deliverable's real dimensions are reached by generating the nearest one and resizing.

## Getting the same thing twice

Reference images, and a conversation. Up to fourteen ride a single request (the pro model reads them as roughly six objects, five characters and three style references), which is how a character, a prop or a palette survives into a second generation. Reusing a \`seed\` holds a composition while the prompt changes; it does not hold a subject.

## What it is not for

- **Not pixel art.** This returns a smooth render, and shrinking one to 32px is a different asset that costs the same. Sprites, tilesets and item icons want an integration that draws on a pixel grid at native size, which a deployment registers beside this one.
- **Not a vector, and not an animation.** It emits \`image/png\` and \`image/jpeg\` and nothing else, so a step declaring \`image/svg+xml\` or \`image/gif\` is refused for holding this alone.
- **Not a deliverable at an exact pixel size.** \`image_size\` is a ladder of four buckets, so a step whose requirement IS 96x96 is refused rather than handed a downscale nobody chose.
- **Not a masked editor.** Editing here rewrites the whole picture from a sentence, so a step whose work is "fix this corner and touch nothing else" is refused at admission rather than handed a whole-image regeneration that looks like a fix.
- **Not 3D, audio, video or documents.** It declares \`image\` alone. A step that must also deliver a mesh needs an integration that makes one selected too, and admission refuses the step rather than letting it discover the gap at the end of a paid run.
- **Not a general Gemini client.** The registered contract is one operation. Text generation, function calling, code execution, the research agents, streaming and stored multi-turn interactions are all on this endpoint and none is registered. Grounding with Google Search is the pointed omission: it bills separately once the monthly free searches are gone, and a step asked to draw a scout has no business searching the web to do it.
- **Not unwatermarked.** Every image carries an invisible SynthID watermark. It is a fact to know about the deliverable, not a problem to route around.
- **Not free, and not free-tier.** None of these models has one, so a project without billing enabled gets \`FAILED_PRECONDITION\` on the first call. There is no balance read and no dry run on this API at all: the request that discovers an exhausted quota is a real one.
- **Not a source of art direction.** It renders the brief it is given. What the subject looks like comes from the task and the step's context services, not from here.`,
  guidance: `Base URL \`https://generativelanguage.googleapis.com\`. Send \`x-goog-api-key: $${NANO_BANANA_CREDENTIAL_KEY}\` as a HEADER on every request, not as a \`?key=\` query parameter, which puts the credential in logs. If that variable is unset the platform could not provide the credential: do NOT call the API and do not invent a key; report the gap as the reason the artifact is missing.

**This one is synchronous.** \`POST /v1beta/interactions\` returns the finished image inline. There is no task id, no polling loop, no expiring link, and nothing to recover if a response is lost, so a dropped connection is a charge with no artifact: treat one request as one attempt.

**The loop that works**

1. Pick the model from the job, not from habit: \`gemini-3.1-flash-lite-image\` to draft, \`gemini-3.1-flash-image\` by default, \`gemini-3-pro-image\` when the image carries text or a character has to stay recognisable. The lite model serves \`1K\` alone, so asking it for \`4K\` is a request that cannot be served.
2. Size the request from the TARGET. \`image_size\` takes \`512px\`, \`1K\`, \`2K\` or \`4K\` and \`aspect_ratio\` takes one of ten fixed ratios, so pick the smallest bucket that covers what the step asked for and resize the bytes afterwards rather than expecting an exact pixel count.
3. Send the brief as one \`text\` block describing the PICTURE: subject, framing, materials, lighting, and the words to render if any. A paragraph beats a keyword list here, and text in the brief is rendered literally.
4. Set \`response_format\` deliberately: \`"type": "image"\` so the model does not answer in prose, and \`mime_type\` \`image/png\` for flat colour, transparency or anything a later step cuts up. \`image/jpeg\` only for a finished photographic image.
5. Leave \`thinking_level\` at \`minimal\` for a brief that already says what the picture is; raise it to \`high\` for dense composition or a lot of in-image text. The interim images it draws are not charged, but the thinking tokens are.
6. **Check that you got an image.** A declined request is not an error status: it answers 200 with \`output_text\` explaining and NO \`output_image\`. Treat that as terminal and REWRITE the brief, since resubmitting the same words buys the same refusal at the same price.
7. Decode \`output_image.data\` from raw base64 (there is no \`data:\` prefix) and store the bytes, using \`output_image.mime_type\` as the content type rather than the one you asked for. Read \`usage.total_output_tokens\` for what it cost; it is the only accounting this API gives.

**Where this step's generation options land on this API.** The brief lists them once, in the platform's words; these are the fields that carry them here, and all of them ride the ONE request. Reference images are \`image\` blocks in \`input\`, up to fourteen, as raw base64 \`data\` rather than a \`uri\`. An instruction edit is an \`image\` block plus the \`text\` block saying what to change; there is no separate edit operation to switch to. A fixed seed is \`generation_config.seed\`. An aspect ratio is \`response_format.aspect_ratio\`, whose ten values are the whole of the list. A negative prompt, a masked edit, a transparent background and a tiling texture have no parameter here at all: report any of them as unmet rather than writing them into the brief and hoping.

**Holding a set together.** Send the first image back as an \`image\` block in the next request's \`input\`, alongside the text that says what to change: that is the edit path, and it is how a turnaround or a variant stays the same character. Send bytes as base64 \`data\` rather than \`uri\`, because Google fetches a \`uri\` from its own network and cannot read a link that needs the platform's credentials.

**Storing what you generated.** Bytes go to the step's configured storage service, never to the repository and never inline in a report, and the storage contract in your context says how. Declare the real content type (\`image/png\` or \`image/jpeg\`) rather than \`application/octet-stream\`.

**Failures worth telling apart.** They all arrive as \`{"error": {"code", "message", "status"}}\`, and the status matters more than the HTTP code. \`INVALID_ARGUMENT\` (400) is a malformed body AND what an invalid key returns, so read the message. \`FAILED_PRECONDITION\` (400) is billing not enabled, which is a gap to report rather than a retry. \`PERMISSION_DENIED\` (403) is a key with no entitlement to that model. \`RESOURCE_EXHAUSTED\` (429) is a rate limit on one of four dimensions (requests, input tokens, requests per DAY, and images per minute, which is the one peculiar to these models), so back off exponentially and do not assume a minute clears it. \`INTERNAL\` (500) and \`UNAVAILABLE\` (503) are transient: retry with backoff rather than switching models, since a different model draws a different picture.`,
})
