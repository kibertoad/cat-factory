import { ASSET_STORAGE_CAPABILITY, PLATFORM_ASSET_STORAGE_SERVICE_ID } from '@cat-factory/contracts'
import type { FoundationalServiceDefinition } from './foundational-service-registry.js'

// ---------------------------------------------------------------------------
// The platform's OWN asset storage, as a `builtin`-tier foundational service.
//
// Why the platform ships one at all, when the registry's own docs say it ships none: a
// binary-output step must select an `asset-storage` catalog service, so with an empty catalog the
// built-in Media task type would be a feature nobody can configure until they have first stood up
// an object store and written an OpenAPI document for it. The bytes have somewhere to go already
// (the account's binary-artifact store, which a local deployment defaults to the filesystem), and
// the only thing missing was an interface the agent could be handed.
//
// It is a service like any other: the agent reads the contract below and calls an HTTP API, with
// no knowledge that the API is ours. What that buys, and the reason it is not merely a
// convenience, is the read-back: the platform holds these bytes, so the run's report can PREVIEW
// and DOWNLOAD them, where an artifact in an org's private bucket can only ever be a location
// string somebody copies.
//
// The credential is the run's own container session token, which the harness already injects for
// the LLM proxy, so nothing here needs a `ToolSecretResolver` entry and no key is declared
// anywhere. The endpoint is per-run and per-transport, so it arrives as an ENVIRONMENT VARIABLE
// rather than as an OpenAPI `servers` entry: a fixed base URL in the document would be a fact this
// package cannot know and every deployment would read as wrong.
// ---------------------------------------------------------------------------

/**
 * The env var naming the asset ingest endpoint inside a run container, and the one carrying its
 * bearer credential.
 *
 * These are the harness's own `ARTIFACT_UPLOAD_URL` / `ARTIFACT_UPLOAD_TOKEN`, restated here
 * because the CONTRACT below names them to the agent and the harness image builds from `src/`
 * plus typescript alone, so it can import no workspace package. That is the same copy-with-a-pin
 * arrangement `host-markdown.ts` and `normalizeProxyPhase` already run under:
 * `artifact-upload.conformity.test.ts` fails if the two spellings drift, so a rename cannot ship
 * with the contract naming a variable nothing sets.
 */
export const ASSET_UPLOAD_URL_ENV = 'ARTIFACT_UPLOAD_URL'
/** The env var carrying the asset ingest credential. See {@link ASSET_UPLOAD_URL_ENV}. */
export const ASSET_UPLOAD_TOKEN_ENV = 'ARTIFACT_UPLOAD_TOKEN'

/** The contract id of the ingest document, stable because a stored selection can name it. */
const PLATFORM_ASSET_CONTRACT_ID = 'ingest'

/**
 * The ingest API, as an OpenAPI document.
 *
 * Written out rather than generated from the route: the two are different artifacts with
 * different audiences (this one is read by a model, the route is served by Hono), and the
 * platform has no OpenAPI emitter for the harness surface to generate it from. What keeps them
 * honest is `platformAssetContract.test.ts`, which pins the operation set the controller mounts
 * against the operations this document declares.
 */
const PLATFORM_ASSET_OPENAPI = JSON.stringify(
  {
    openapi: '3.1.0',
    info: {
      title: 'Platform asset storage',
      version: '1.0.0',
      description:
        'Stores a generated binary asset and returns the location to record for it. The base ' +
        `URL is the value of the \`${ASSET_UPLOAD_URL_ENV}\` environment variable; authenticate ` +
        `every request with \`Authorization: Bearer $${ASSET_UPLOAD_TOKEN_ENV}\`. Both are set ` +
        'for you inside this run. If either is unset, the platform could not provide storage: ' +
        'do not attempt an upload, and report it.',
    },
    paths: {
      '/': {
        post: {
          operationId: 'storeAsset',
          summary: 'Store one generated asset',
          description:
            'Upload exactly one file per request. The response `location` is what you record ' +
            'for this artifact in your final declaration block; it is the only handle anyone ' +
            'has on the stored bytes afterwards.',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                      description:
                        'The asset itself. Send the real media type on the part; it is stored ' +
                        'as declared and is what a browser is later served.',
                    },
                    name: {
                      type: 'string',
                      description:
                        'A short label for what this asset is (the subject or entity it ' +
                        'depicts). Shown beside the artifact; not a filename and not an id.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Stored.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['location', 'contentType', 'byteSize'],
                    properties: {
                      location: {
                        type: 'string',
                        description: 'Record this verbatim as the artifact’s `location`.',
                      },
                      contentType: { type: 'string' },
                      byteSize: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '413': { description: 'The file is larger than this deployment accepts.' },
            '415': { description: 'The declared media type is not one this store accepts.' },
            '429': { description: 'This run has stored as many assets as it may.' },
            '503': { description: 'This deployment has no content storage configured.' },
          },
        },
      },
    },
  },
  null,
  2,
)

/**
 * The platform's own asset-storage service, for `defaultFoundationalServiceRegistry()`.
 *
 * A function rather than a constant so every registry gets its own object: the registry holds
 * definitions by reference and a shared literal would let one deployment's mutation reach
 * another's catalog in a test process running several.
 */
export function platformAssetStorageService(): FoundationalServiceDefinition {
  return {
    id: PLATFORM_ASSET_STORAGE_SERVICE_ID,
    name: 'Platform asset storage',
    summary: 'Stores generated assets in this deployment’s own content storage.',
    description:
      'The storage this platform runs for itself, offered as an asset store so a generating ' +
      'step has somewhere to deliver without an external object store. Where the bytes ' +
      'physically land is an account-level setting (an object store, a database table, or the ' +
      'local filesystem on a local deployment); assets stored here are readable back from the ' +
      'run that produced them, and are exempt from the retention sweep that reclaims a run’s ' +
      'debris. Upload one file per request; record the `location` the response returns.',
    capabilities: [ASSET_STORAGE_CAPABILITY],
    contracts: [
      {
        contractId: PLATFORM_ASSET_CONTRACT_ID,
        format: 'openapi',
        title: 'Asset ingest API',
        body: PLATFORM_ASSET_OPENAPI,
      },
    ],
  }
}
