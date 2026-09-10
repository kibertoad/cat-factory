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
        'Server-sent events for a headless job run: `progress` frames until a terminal `done`/`error`/`stopped`/`timeout` event, plus a `decision` frame announcing each park. For what the run is asking, and how a chunked operation is progressing through it, stream `GET /api/v1/runs/{runId}/decision-events` beside this. Authenticated by the API key header.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
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
        'Server-sent events for a board task run: `progress` frames (the rich run projection) until a terminal `done`/`error` event, or a `timeout` when the connection cap is reached, plus a `decision` frame announcing each park. For what the run is asking, and how a chunked operation is progressing through it, stream `GET /api/v1/runs/{runId}/decision-events` beside this. Authenticated by the API key header.',
      parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
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

  // The DECISION stream: the point read’s push twin, and the one channel on which a chunked
  // operation (a PR deep review’s slices, an expedition’s angles) reports progress at all. Keyed
  // by RUN like the list it streams, so it serves a board task and a headless job alike.
  tags.add('Decisions')
  paths[`${API_PREFIX}/runs/{runId}/decision-events`] = {
    get: {
      operationId: 'streamPublicRunDecisions',
      // Hand-documented route: the handler's own `authorize(c, 'read')` literal, restated here
      // because there is no contract to read it off. Keep the two in step.
      'x-min-scope': 'read',
      tags: ['Decisions'],
      summary: 'Stream a run’s parked decisions (SSE)',
      description:
        'Server-sent events over the run’s whole decision list: a `decision-state` frame carrying the same payload `GET /api/v1/runs/{runId}/decisions` serves, pushed whenever it changes, then a terminal `done` when the run settles or a `timeout` at the connection cap. This is how a chunked operation reports progress: a PR deep review’s slice count, a bug-fishing angle landing and a challenge verdict all move the decision list without moving the run, so they produce no `progress` frame on the run streams. Authenticated by the API key header.',
      parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'An event stream of the run’s decision list',
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
