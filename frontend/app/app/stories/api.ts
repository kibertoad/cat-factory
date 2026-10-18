// Answering a story's API requests.
//
// Some components call a store loader on mount, and a loader sends a request. In Storybook no
// backend answers it, so the story fails with "Failed to fetch". A story declares the responses
// it needs as `parameters.api`, and `preview.ts` installs them on an msw worker before the story
// renders.
//
// A response is built from the route CONTRACT the app's own client uses, and its body is
// validated against the contract's 200 schema when the story loads. So a fixture that drifts from
// the API fails loudly instead of rendering a shape the backend would never send.
import type { ApiContract } from '@toad-contracts/core'
import { http, HttpResponse, type HttpHandler } from 'msw'
import { setupWorker, type SetupWorker } from 'msw/browser'
import type { SuccessBodyOf } from '~/composables/api/client'
import { storyWorkspacePrefix } from './workspace'

/** Hosts Storybook itself fetches from: Iconify's icon API, and the fonts in `preview-head.html`. */
const STORYBOOK_HOSTS = new Set(['api.iconify.design', 'fonts.googleapis.com', 'fonts.gstatic.com'])

let worker: SetupWorker | undefined

/** Start the worker once per preview. Requests nothing answers pass through and are logged. */
export async function startApiWorker(): Promise<void> {
  if (worker) return
  // DEBUG ONLY: when this frame's worker start begins and ends.
  const iframe = new URLSearchParams(location.search).get('iframeId')?.split('/').pop()
  const beacon = (kind: string) =>
    navigator.sendBeacon('/__mswlog', JSON.stringify({ t: Date.now(), kind, iframe }))
  beacon('start-begin')
  worker = setupWorker()
  await worker.start({
    quiet: true,
    serviceWorker: { url: './mockServiceWorker.js' },
    onUnhandledRequest(request, print) {
      // Every request goes through the worker, Vite's modules and the icon and font CDNs
      // included. Anything else is an API call no story answered.
      const { origin, hostname } = new URL(request.url)
      if (origin !== window.location.origin && !STORYBOOK_HOSTS.has(hostname)) print.warning()
    },
  })
  beacon('start-end')
}

/** Replace the installed responses with the story's own. */
export function installApiResponses(handlers: readonly HttpHandler[]): void {
  worker?.resetHandlers(...handlers)
}

/** The part of the Standard Schema interface this file uses. */
interface StandardValidator {
  '~standard': {
    validate: (
      value: unknown,
    ) => { value: unknown; issues?: undefined } | { issues: readonly unknown[] } | Promise<unknown>
  }
}

function isStandardSchema(value: unknown): value is StandardValidator {
  return typeof value === 'object' && value !== null && '~standard' in value
}

/** The success status a contract answers with: 200, or 201 for a create. */
function successStatus(contract: ApiContract): 200 | 201 {
  return isStandardSchema(contract.responsesByStatusCode[200]) ? 200 : 201
}

/**
 * Validate `body` against the contract's success schema (200, or 201 for a create),
 * synchronously, and return the output.
 */
function validated(contract: ApiContract, body: unknown): unknown {
  const schema: unknown = contract.responsesByStatusCode[successStatus(contract)]
  if (!isStandardSchema(schema)) {
    throw new Error(
      `No 200 or 201 JSON schema on the contract for ${contract.method.toUpperCase()}`,
    )
  }
  const result = schema['~standard'].validate(body)
  if (result instanceof Promise) throw new Error('An async response schema is not supported')
  if (result.issues) {
    throw new Error(`Story fixture does not match the contract: ${JSON.stringify(result.issues)}`)
  }
  return result.value
}

/** A success response (200, or 201 for a create) for `contract`, at the path the app's client would request. */
export function apiResponse<T extends ApiContract>(
  contract: T,
  params: {
    body: SuccessBodyOf<T>
    pathPrefix?: string
    pathParams?: Parameters<T['pathResolver']>[0]
  },
): HttpHandler {
  const path = `${params.pathPrefix ?? ''}${contract.pathResolver(params.pathParams)}`
  const json = validated(contract, params.body)
  // `*` matches any origin, so a story does not depend on the configured API base.
  const text = JSON.stringify(json)
  const status = successStatus(contract)
  return http[contract.method](
    `*${path}`,
    () => new HttpResponse(text, { status, headers: { 'content-type': 'application/json' } }),
  )
}

/**
 * A response that never finishes: the status and headers arrive at once, the body never ends.
 *
 * The app reads the body before it uses a response, so the request stays pending and the component
 * stays on its loading state. A handler that never returned (`delay('infinite')`) would keep the
 * service worker's `fetch` event open instead: Chromium stops a worker whose event stays open for
 * about five minutes, and every request the worker was passing on fails with it. Settling the event
 * with a later error is no better, because the app would act on that error after its story ended.
 */
function neverEndingResponse(status: number, contentType: string): Response {
  return new HttpResponse(new ReadableStream<Uint8Array>(), {
    status,
    headers: { 'content-type': contentType },
  })
}

/**
 * A request that never answers, for a `Loading` story: the component stays on its pending state
 * for as long as the story is open.
 */
export function apiPending<T extends ApiContract>(
  contract: T,
  params: { pathPrefix?: string; pathParams?: Parameters<T['pathResolver']>[0] } = {},
): HttpHandler {
  const path = `${params.pathPrefix ?? ''}${contract.pathResolver(params.pathParams)}`
  return http[contract.method](`*${path}`, () =>
    neverEndingResponse(successStatus(contract), 'application/json'),
  )
}

/**
 * A refused request, for an `Error` story: the 500 envelope the backend's error handler sends for
 * an unexpected fault (`handleError` in `@cat-factory/server`), with the request id (a UUID) a
 * deployment that logs requests adds.
 */
export function apiFailure<T extends ApiContract>(
  contract: T,
  params: { pathPrefix?: string; pathParams?: Parameters<T['pathResolver']>[0] } = {},
): HttpHandler {
  return apiRefusal(contract, {
    ...params,
    status: 500,
    error: {
      code: 'internal',
      message: 'Internal server error',
      requestId: '7f3c2a10-5b9e-4c1d-9a64-2e8f0b6d4c31',
    },
  })
}

/**
 * A request the backend refuses on purpose, with the status and the `error` envelope it sends for
 * that case: a wrong password, an expired link. Copy the code and message from the handler that
 * refuses, so the story shows what a user reads.
 */
export function apiRefusal<T extends ApiContract>(
  contract: T,
  params: {
    status: number
    error: { code: string; message: string; requestId?: string; details?: Record<string, unknown> }
    pathPrefix?: string
    pathParams?: Parameters<T['pathResolver']>[0]
  },
): HttpHandler {
  const path = `${params.pathPrefix ?? ''}${contract.pathResolver(params.pathParams)}`
  return http[contract.method](`*${path}`, () =>
    HttpResponse.json({ error: params.error }, { status: params.status }),
  )
}

/** A 204 with no body, for a contract whose success has no 200 schema (a reset link request). */
export function apiNoContent<T extends ApiContract>(
  contract: T,
  params: { pathPrefix?: string; pathParams?: Parameters<T['pathResolver']>[0] } = {},
): HttpHandler {
  const path = `${params.pathPrefix ?? ''}${contract.pathResolver(params.pathParams)}`
  return http[contract.method](`*${path}`, () => new HttpResponse(null, { status: 204 }))
}

/**
 * A response computed from the request, for a story that lets the user act: a drag on the board
 * sends a write, and the answer has to be the block as moved. `respond` gets the raw body and
 * parses it with the contract's request schema; the answer is validated against the 200 schema.
 * A read has no body, so `body` is `undefined` there, and the handler answers for any path
 * parameter, e.g. the block the user just selected. `query` is the request's query string, for a
 * read whose answer depends on it (one folder of a repo tree).
 *
 * `pattern` names each path parameter as msw should match it, e.g. `{ blockId: ':blockId' }`.
 */
export function apiHandler<T extends ApiContract>(
  contract: T,
  params: { pathPrefix?: string; pattern: Parameters<T['pathResolver']>[0] },
  respond: (input: {
    pathParams: Record<string, string>
    body: unknown
    query: URLSearchParams
  }) => SuccessBodyOf<T>,
): HttpHandler {
  const path = `${params.pathPrefix ?? ''}${contract.pathResolver(params.pattern)}`
  return http[contract.method](`*${path}`, async ({ params: pathParams, request }) => {
    const flat: Record<string, string> = {}
    for (const [key, value] of Object.entries(pathParams)) {
      if (typeof value === 'string') flat[key] = value
    }
    const text = await request.text()
    const body: unknown = text ? JSON.parse(text) : undefined
    const query = new URL(request.url).searchParams
    const json = validated(contract, respond({ pathParams: flat, body, query }))
    return new HttpResponse(JSON.stringify(json), {
      status: successStatus(contract),
      headers: { 'content-type': 'application/json' },
    })
  })
}

/**
 * The bytes a stored artifact serves, as `image/png` unless a type is given: one artifact's when
 * `artifactId` is given, else every artifact's. The blob route has no contract: the client asks
 * for a `Blob` and turns it into an object URL, and a component that branches on the served type
 * reads `blob.type`, which is this content type.
 */
export function artifactBlobResponse(
  bytes: Uint8Array<ArrayBuffer>,
  options: { artifactId?: string; contentType?: string } = {},
): HttpHandler {
  return http.get(
    `*${storyWorkspacePrefix}/artifacts/${options.artifactId ?? ':artifactId'}/blob`,
    () =>
      new HttpResponse(bytes, {
        headers: { 'content-type': options.contentType ?? 'image/png' },
      }),
  )
}

/** One artifact's bytes that never arrive, for a component's loading state. */
export function artifactBlobPending(artifactId: string): HttpHandler {
  return http.get(`*${storyWorkspacePrefix}/artifacts/${artifactId}/blob`, () =>
    neverEndingResponse(200, 'image/png'),
  )
}

/** One artifact's bytes refused with the backend's 500, for a component's error state. */
export function artifactBlobFailure(artifactId: string): HttpHandler {
  return http.get(`*${storyWorkspacePrefix}/artifacts/${artifactId}/blob`, () =>
    HttpResponse.json(
      { error: { code: 'internal', message: 'Internal server error' } },
      { status: 500 },
    ),
  )
}
