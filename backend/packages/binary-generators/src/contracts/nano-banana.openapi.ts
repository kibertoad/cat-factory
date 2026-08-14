// Google's Gemini Interactions API, narrowed to Nano Banana image generation, as an OpenAPI 3.1
// document.
//
// Authored here because Google publishes this surface as prose, curl snippets and SDK reference
// pages rather than as a machine-readable spec a registry can hand to an agent. The document is
// what a run actually reads: the registry renders it into `.cat-context/` beside the brief, and
// the agent writes its request from this and nothing else.
//
// WHAT IS IN IT is one operation, and that is not a small integration written small: it is the
// whole of what a step needs. Generation here is SYNCHRONOUS, so the response to
// `POST /v1beta/interactions` carries the image bytes inline as base64. There is no task to poll,
// no signed URL to race, and correspondingly no second endpoint.
//
// The Interactions API is a great deal more than image generation, and the rest is deliberately
// absent: text and audio and video generation, function calling, code execution, computer use,
// the Deep Research and Antigravity agents, file search, streaming, `background` execution with
// its `GET`/`DELETE`/`cancel` lifecycle, and stored multi-turn interactions
// (`previous_interaction_id`). Grounding tools (Google Search, Google Maps, URL context) are the
// omission worth naming twice, because they are the one that bills: 5,000 free searches a month
// across all Gemini 3.x usage on the key, then $14 per 1,000. A step asked to draw a scout has no
// business searching the web to do it, and an interface an agent is handed is an interface it
// will use.
//
// MODEL NAMES ARE BAKED IN HERE, which wants its reason because a vendor's model list is usually
// the first thing a document like this gets wrong. `model` is a REQUIRED enum field on every
// request, there is no discovery operation registered, and the three image models are a cost
// ladder rather than a price list, so an agent that cannot name one cannot make a request at all.
//
// `satisfies OpenAPIV3_1.Document` is what makes "authored in TypeScript" worth anything: a typo'd
// `$ref` or a parameter with no `in` is a compile error here rather than a garbled context file at
// dispatch. The ANNOTATION stays `Record<string, unknown>` so `openapi-types` does not reach
// consumers through this package's `.d.ts`: the checking is ours, and the shipped shape is what
// `openApiContract` takes.
//
// WHAT NO TEST HERE CAN HOLD, listed because an unlisted unchecked fact is one nobody re-checks.
// The type system holds this document's shape and `openapi-documents.test.ts` holds its internal
// references, but every NAME and NUMBER below was transcribed from Google's docs and will go stale
// without failing anything:
//
//   - the three image model ids, and the resolutions each supports (Lite is 1K only);
//   - 14 reference images, and the per-model split between objects, characters and style refs;
//   - the ten aspect ratios and the four `image_size` values;
//   - the per-image prices in the generator's description, and the $60 / $120 per 1M output
//     token rates behind them;
//   - SynthID watermarking of every generated image.
//
// A vendor that changes one of these ships an integration that still compiles, still passes, and
// is wrong at dispatch. Re-read them against https://ai.google.dev/gemini-api/docs/image-generation
// when touching this file.

import type { OpenAPIV3_1 } from 'openapi-types'

/** The catalog-facing OpenAPI document for Nano Banana on `https://generativelanguage.googleapis.com`. */
export const NANO_BANANA_OPENAPI: Record<string, unknown> = {
  openapi: '3.1.0',
  info: {
    title: 'Gemini Interactions API (Nano Banana image generation)',
    version: 'v1beta',
    description:
      'Text-to-image and reference-guided image generation and editing, through the one ' +
      '`interactions` endpoint. Every request carries the `x-goog-api-key` header. Generation is ' +
      'SYNCHRONOUS: the response carries the finished image inline as base64, so there is no ' +
      'task, no poll and no expiring link. A request the model declines is not an error status: ' +
      'it answers 200 with a text block explaining the refusal and no image block at all.',
  },
  servers: [{ url: 'https://generativelanguage.googleapis.com' }],
  security: [{ googleApiKey: [] }],
  paths: {
    '/v1beta/interactions': {
      post: {
        operationId: 'createImageInteraction',
        summary: 'Generate or edit an image and receive the bytes inline',
        description:
          'One call, one image. Send the brief as a `text` block and any reference images as ' +
          '`image` blocks in the same `input` array; the response carries the result as base64 ' +
          'in `output_image`, and `usage` reports what it cost in tokens. There is no balance ' +
          'read on this API and no dry run, so the request that discovers an exhausted quota is ' +
          'a real one.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ImageInteractionRequest' },
            },
          },
        },
        responses: {
          '200': {
            description:
              'The interaction completed. It carries an image when the model produced one and ' +
              'text alone when it declined, so check for the image rather than assuming it.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Interaction' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '403': { $ref: '#/components/responses/PermissionDenied' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '500': { $ref: '#/components/responses/ServerError' },
          '503': { $ref: '#/components/responses/Unavailable' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      googleApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-goog-api-key',
        description:
          'An API key from Google AI Studio. Send it as this header rather than as a `?key=` ' +
          'query parameter, which puts the credential in logs and referrers.',
      },
    },
    responses: {
      BadRequest: {
        description:
          'The request was rejected. `INVALID_ARGUMENT` is a malformed body, and also what an ' +
          'invalid API key returns, so read `error.message` rather than assuming the body is at ' +
          'fault. `FAILED_PRECONDITION` is billing not enabled on the project, which every image ' +
          'model requires since none has a free tier.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
      PermissionDenied: {
        description:
          '`PERMISSION_DENIED`: the key is valid but not entitled to this model. A rewrite of ' +
          'the request will not fix it; report it as a gap.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
      RateLimited: {
        description:
          '`RESOURCE_EXHAUSTED`, a rate limit on any of four dimensions: requests per minute, ' +
          'input tokens per minute, requests per day, and IMAGES per minute, which is the one ' +
          'peculiar to these models. Back off exponentially; the daily one does not clear by ' +
          'waiting a minute.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
      ServerError: {
        description: '`INTERNAL`: a fault on Google’s side. Retry with backoff.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
      Unavailable: {
        description:
          '`UNAVAILABLE`: the model is temporarily overloaded. Retry with backoff rather than ' +
          'switching models mid-set, since a different model draws a different picture.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    },
    schemas: {
      ImageInteractionRequest: {
        type: 'object',
        required: ['model', 'input'],
        properties: {
          model: { $ref: '#/components/schemas/ImageModel' },
          input: {
            type: 'array',
            description:
              'The prompt, as an ordered list of blocks. One `text` block is the brief; each ' +
              '`image` block is a reference the model composes from or edits, up to 14 of them ' +
              'on one request (the pro model reads them as roughly six objects, five characters ' +
              'and three style references).',
            items: { $ref: '#/components/schemas/InputBlock' },
          },
          response_format: { $ref: '#/components/schemas/ImageResponseFormat' },
          generation_config: { $ref: '#/components/schemas/GenerationConfig' },
        },
      },
      ImageModel: {
        type: 'string',
        enum: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'],
        description:
          'Which image model draws it: a cost ladder, not a feature list. ' +
          '`gemini-3.1-flash-image` (Nano Banana 2) is the default working model and reaches 4K. ' +
          '`gemini-3.1-flash-lite-image` is the cheapest and is 1K ONLY, so pairing it with a ' +
          'larger `image_size` is a request that cannot be served. `gemini-3-pro-image` (Nano ' +
          'Banana Pro) is the premium model: the best text rendering and identity consistency, ' +
          'roughly twice the price, and the one to reach for when the image has to carry legible ' +
          'words. `gemini-2.5-flash-image` (the original Nano Banana) is legacy and not offered ' +
          'here.',
      },
      InputBlock: {
        description: 'One block of the prompt: the written brief, or a reference image.',
        oneOf: [
          { $ref: '#/components/schemas/TextInput' },
          { $ref: '#/components/schemas/ImageInput' },
        ],
      },
      TextInput: {
        type: 'object',
        required: ['type', 'text'],
        properties: {
          type: { type: 'string', const: 'text' },
          text: {
            type: 'string',
            description:
              'What the image IS: subject, framing, materials, lighting, and the words to render ' +
              'if any. Describe the picture rather than listing keywords; these models read a ' +
              'paragraph better than a tag soup, and they render text in the brief literally.',
          },
        },
      },
      ImageInput: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', const: 'image' },
          data: {
            type: 'string',
            description:
              'The reference image as RAW base64, with no `data:` prefix. Send bytes this way ' +
              'rather than by `uri`, since a bearer-gated storage link is not something Google’s ' +
              'network can fetch.',
          },
          uri: {
            type: 'string',
            description:
              'A Files API URI for an image already uploaded to this project. Not a general ' +
              'URL fetcher.',
          },
          mime_type: {
            type: 'string',
            enum: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
            description: 'The format of `data`. Declare it; do not leave it to be sniffed.',
          },
        },
      },
      ImageResponseFormat: {
        type: 'object',
        description:
          'What to produce. Omitting it entirely yields a 1:1 1K PNG, which is rarely the size ' +
          'the deliverable actually wants.',
        properties: {
          type: {
            type: 'string',
            const: 'image',
            description: 'Ask for an image. Without it the model may answer with text.',
          },
          mime_type: {
            type: 'string',
            enum: ['image/png', 'image/jpeg'],
            description:
              'The container. `image/png` for flat colour, transparency, or anything a later ' +
              'step will cut up; `image/jpeg` only for a finished photographic image, since its ' +
              'artefacts survive every edit after it.',
          },
          aspect_ratio: {
            type: 'string',
            enum: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
            description:
              'The shape. This is a CLOSED list, not a free-form ratio: a deliverable whose ' +
              'required proportions are not on it is generated at the nearest ratio and cropped ' +
              'afterwards, never requested directly.',
          },
          image_size: {
            type: 'string',
            enum: ['512px', '1K', '2K', '4K'],
            description:
              'The resolution, and the price. The `K` is capitalised and the values are exact ' +
              'strings. `gemini-3.1-flash-lite-image` serves `1K` alone; the other two serve all ' +
              'four.',
          },
        },
      },
      GenerationConfig: {
        type: 'object',
        properties: {
          thinking_level: {
            type: 'string',
            enum: ['minimal', 'low', 'medium', 'high'],
            description:
              'How much the model reasons before drawing. `minimal` is the default and is right ' +
              'for a brief that already says what the picture is; `high` earns its keep on ' +
              'composition-heavy work and on images with a lot of text in them. The interim ' +
              'images it draws while thinking are not charged, but the thinking TOKENS are.',
          },
          seed: {
            type: 'integer',
            description:
              'Reuse to iterate on one composition while the prompt changes. It does not hold a ' +
              'character; reference images do.',
          },
        },
      },
      Interaction: {
        type: 'object',
        description: 'One completed generation. The image is inline; nothing here expires.',
        properties: {
          id: { type: 'string', description: 'The interaction id, for support and for logs.' },
          object: { type: 'string', description: 'Always `interaction`.' },
          model: { $ref: '#/components/schemas/ImageModel' },
          status: {
            type: 'string',
            enum: [
              'completed',
              'in_progress',
              'queued',
              'requires_action',
              'incomplete',
              'failed',
              'cancelled',
              'budget_exceeded',
            ],
            description:
              'For a plain image request this is `completed`. The asynchronous states belong to ' +
              '`background` interactions, which this integration does not use.',
          },
          output_image: {
            $ref: '#/components/schemas/OutputImage',
          },
          output_text: {
            type: 'string',
            description:
              'The model’s text, concatenated. On a successful generation it is commentary; when ' +
              'there is NO `output_image` it is the refusal, and it is the only thing that says ' +
              'why.',
          },
          steps: {
            type: 'array',
            description:
              'The full interleaved transcript. `output_image` is the last image out of it, ' +
              'which is what a single-image request wants; read this only when a request ' +
              'produced several.',
            items: { $ref: '#/components/schemas/Step' },
          },
          usage: { $ref: '#/components/schemas/Usage' },
          created: { type: 'string', description: 'ISO 8601 creation timestamp.' },
        },
      },
      Step: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: {
            type: 'string',
            enum: ['model_output', 'user_input', 'function_call'],
            description: 'Generated images are on the `model_output` steps.',
          },
          content: {
            type: 'array',
            description: 'The blocks of this step, in order.',
            items: { $ref: '#/components/schemas/OutputContent' },
          },
        },
      },
      OutputContent: {
        description: 'One block of a step’s output.',
        oneOf: [
          { $ref: '#/components/schemas/OutputImage' },
          { $ref: '#/components/schemas/OutputText' },
        ],
      },
      OutputImage: {
        type: 'object',
        description:
          'A generated image, inline. Every one carries an invisible SynthID watermark, which ' +
          'survives ordinary edits and is not something to try to remove.',
        properties: {
          type: { type: 'string', const: 'image' },
          data: {
            type: 'string',
            description:
              'The image as RAW base64 with no `data:` prefix. DECODE IT before storing: ' +
              'storing the base64 text is a corrupt asset that looks like a successful run.',
          },
          mime_type: {
            type: 'string',
            enum: ['image/png', 'image/jpeg'],
            description:
              'What the bytes actually are. Store this as the asset’s content type rather than ' +
              'the one you asked for.',
          },
        },
      },
      OutputText: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'text' },
          text: { type: 'string' },
        },
      },
      Usage: {
        type: 'object',
        description:
          'What the interaction cost, in tokens. This is the only accounting the API offers, ' +
          'there is no balance endpoint anywhere on this surface.',
        properties: {
          total_input_tokens: { type: 'integer', description: 'Prompt and reference images.' },
          total_output_tokens: {
            type: 'integer',
            description:
              'The image, billed at the model’s image-output rate. Roughly 1,120 tokens for a 1K ' +
              'image on the flash model and 2,520 for a 4K one, so resolution IS the bill.',
          },
          total_thought_tokens: {
            type: 'integer',
            description: 'Reasoning, when `thinking_level` asked for any. Billed.',
          },
          total_tokens: { type: 'integer' },
          output_tokens_by_modality: {
            type: 'array',
            description: 'The output split by kind, which is how the image half is isolated.',
            items: { $ref: '#/components/schemas/ModalityTokens' },
          },
        },
      },
      ModalityTokens: {
        type: 'object',
        properties: {
          modality: {
            type: 'string',
            description: 'e.g. `TEXT`, `IMAGE`.',
          },
          token_count: { type: 'integer' },
        },
      },
      ErrorEnvelope: {
        type: 'object',
        description: 'Google’s standard error wrapper. Every failure on this API arrives in it.',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'integer', description: 'The HTTP status, repeated.' },
              message: {
                type: 'string',
                description:
                  'The human-readable reason. Read it, since the status alone is ambiguous.',
              },
              status: {
                type: 'string',
                description:
                  'The canonical code, e.g. `INVALID_ARGUMENT`, `PERMISSION_DENIED`, ' +
                  '`RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `INTERNAL`, `UNAVAILABLE`.',
              },
              details: {
                type: 'array',
                description: 'Structured detail, when the service attaches any.',
                items: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies OpenAPIV3_1.Document
