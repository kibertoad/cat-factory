// The `/api/v1` routes that are NOT route contracts, documented by hand.
//
// Everything else in the spec is DERIVED: `generate-openapi.mjs` walks the Valibot contracts, so a
// path, a body and a response shape there cannot drift from what the server serves. These four
// cannot be, because their responses are not JSON schemas the contract layer can describe: two
// `text/event-stream` SSE streams and one image/octet-stream blob read.
//
// That makes them the one place in the spec a human has to keep in step with the server, and the
// two facts most easily lost are stated at each site: the handler's own `authorize(c, '<scope>')`
// literal, restated here as `x-min-scope` because there is no contract to read it off, and the
// event names each stream emits.
//
// Their own module because the generator is against its line budget and this is a self-contained
// block of literals rather than part of that file's derivation: it takes the `paths` object and
// the `tags` set and adds to both.

import {
  API_PREFIX,
  BINARY_SCHEMA,
  BLOB_MEDIA_TYPES,
  STATUS_DESCRIPTIONS,
} from './spec-constants.mjs'

/**
 * The opt-in DECISION channel both SSE routes accept.
 *
 * Declared once and shared, because the two streams must accept exactly the same values: a caller
 * that learned the flag on one and had it refused on the other would read the refusal as the run
 * having nothing to say. Opt-in rather than always on because projecting a decision list costs
 * point reads in several stores per tick.
 */
const DECISION_CHANNEL_PARAMETER = {
  name: 'decisions',
  in: 'query',
  required: false,
  description:
    'Set to `true` to add `decision-state` frames carrying the whole decision list for the run (the same payload `GET /api/v1/runs/{runId}/decisions` serves), pushed whenever it changes. This is how a chunked operation reports progress: a PR deep review slice count, a bug-fishing angle landing and a challenge verdict all move the decision list without moving the run, so they produce no `progress` frame. A value other than `true`, `false`, `1` or `0` is refused with `422 validation` (`details.reason: "invalid_query_parameter"`) rather than read as off.',
  schema: { type: 'string', enum: ['true', 'false', '1', '0'] },
}

export function addHandDocumentedRoutes(paths, tags) {
  // The raw SSE routes that are NOT contracts (streaming Hono routes), documented by hand.
  tags.add('Jobs')
  paths[`${API_PREFIX}/jobs/{id}/events`] = {
    get: {
      operationId: 'streamPublicJobEvents',
      // Hand-documented route: the handler's own `authorize(c, 'read')` literal, restated here
      // because there is no contract to read it off. Keep the two in step.
      'x-min-scope': 'read',
      tags: ['Jobs'],
      summary: 'Stream a job (SSE)',
      description:
        'Server-sent events for a headless job run: `progress` frames until a terminal `done`/`error`/`stopped`/`timeout` event, plus a `decision` frame announcing each park. Pass `?decisions=true` to add `decision-state` frames carrying what the run is asking. Authenticated by the API key header.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        DECISION_CHANNEL_PARAMETER,
      ],
      responses: {
        200: {
          description: 'An event stream of job updates',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        '4XX': {
          description: STATUS_DESCRIPTIONS['4XX'],
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  }
  tags.add('Tasks')
  paths[`${API_PREFIX}/tasks/{taskId}/events`] = {
    get: {
      operationId: 'streamPublicTaskRun',
      // Hand-documented route: the handler's own `authorize(c, 'read')` literal, restated here
      // because there is no contract to read it off. Keep the two in step.
      'x-min-scope': 'read',
      tags: ['Tasks'],
      summary: 'Stream a task run (SSE)',
      description:
        'Server-sent events for a board task run: `progress` frames (the rich run projection) until a terminal `done`/`error` event, or a `timeout` when the connection cap is reached, plus a `decision` frame announcing each park. Pass `?decisions=true` to add `decision-state` frames carrying what the run is asking. Authenticated by the API key header.',
      parameters: [
        { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
        DECISION_CHANNEL_PARAMETER,
      ],
      responses: {
        200: {
          description: 'An event stream of run updates',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        '4XX': {
          description: STATUS_DESCRIPTIONS['4XX'],
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  }

  // The artifact BYTES: not a route contract, because the response is an image rather than JSON.
  // Documented by hand for the same reason the two SSE routes above are, and named in the SDK
  // surface table so all four clients expose it (each transport reads the body as bytes).
  tags.add('Evidence')
  paths[`${API_PREFIX}/artifacts/{artifactId}/blob`] = {
    get: {
      operationId: 'getPublicArtifactBlob',
      // Hand-documented route: the handler's own `authorize(c, 'read')` literal, restated here
      // because there is no contract to read it off. Keep the two in step.
      'x-min-scope': 'read',
      tags: ['Evidence'],
      summary: "Download an artifact's bytes",
      description:
        'The stored bytes of one artifact listed by the run-artifacts endpoint, served with the recorded image content type (`nosniff`, never inline active content). Authenticated like every other call: the bytes are workspace-scoped, so a report that links here on a public repository leaks nothing to a reader without a key. 404 when the id is unknown to the key’s workspace, and separately when the metadata row survives but its bytes are gone from the blob backend.',
      parameters: [{ name: 'artifactId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'The artifact bytes',
          // Every type the route can actually answer with, not one standing in for the rest: the
          // handler serves the artifact's RECORDED type clamped to the image allow-list, and
          // falls back to octet-stream only for a stored row it does not recognise. Declaring a
          // single type would tell anyone generating a client from this document to expect a
          // media type the endpoint never sends. `blobMediaTypes.spec.ts` pins this set to the
          // server's own allow-list, so the two cannot drift.
          content: Object.fromEntries(
            BLOB_MEDIA_TYPES.map((media) => [media, { schema: BINARY_SCHEMA }]),
          ),
        },
        '4XX': {
          description: STATUS_DESCRIPTIONS['4XX'],
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  }
}
