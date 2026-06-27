import type {
  ApiContract,
  ClientRequestParams,
  DefaultStreaming,
  InferNonSseClientResponse,
  SuccessfulHttpStatusCode,
} from '@toad-contracts/core'
import {
  type ContractRequestOptions,
  sendByApiContract,
  type WretchInstance,
} from '@toad-contracts/frontend-http-client'
import wretch from 'wretch'
import { ApiError } from './errors'

/**
 * The validated success-response body inferred from a route contract (every REST
 * endpoint here is non-SSE). This is what {@link ApiSend} resolves to.
 */
export type SuccessBodyOf<T extends ApiContract> = Extract<
  InferNonSseClientResponse<T>,
  { statusCode: SuccessfulHttpStatusCode }
>['body']

/** The request params a contract requires (pathParams/body/queryParams/headers), per the contract. */
export type SendParams<T extends ApiContract> = ClientRequestParams<
  T,
  DefaultStreaming<T['responsesByStatusCode']>
> &
  ContractRequestOptions<true>

/**
 * A bound, throw-on-error sender: validates the response against the contract and
 * returns the success body, or throws the typed error (an `UnexpectedResponseError`
 * or a declared non-2xx response). Preserves the throwing ergonomics the Pinia
 * stores already expect from the old `$fetch` client.
 */
export type ApiSend = <T extends ApiContract>(
  contract: T,
  params: SendParams<T>,
) => Promise<SuccessBodyOf<T>>

/**
 * Build the authed wretch client. Ports the concerns the old `$fetch` client had:
 * base URL from runtime config, a lazily-read bearer token (so a fresh token applies
 * without rebuilding the client), and a 401 → re-gate.
 */
export function createApiClient(): WretchInstance {
  const apiBase = useRuntimeConfig().public.apiBase
  return wretch(apiBase).middlewares([
    (next) => async (url, opts) => {
      const token = useAuthStore().token
      if (token) {
        opts.headers = {
          ...(opts.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${token}`,
        }
      }
      const response = await next(url, opts)
      // A 401 means our token lapsed or was revoked — drop it so the UI re-gates.
      if (response.status === 401) useAuthStore().handleUnauthorized()
      return response
    },
  ])
}

/**
 * Send a contract request and unwrap to the success body (or throw the typed error).
 * The public signature preserves per-contract inference for callers; inside,
 * sendByApiContract's deeply-conditional result type can't be proven equal to
 * SuccessBodyOf<T> generically, so the success body is asserted at this single boundary.
 */
export async function sendContract<T extends ApiContract>(
  client: WretchInstance,
  contract: T,
  params: SendParams<T>,
): Promise<SuccessBodyOf<T>> {
  const outcome = await sendByApiContract(client, contract, params)
  if (outcome.error) {
    const error = outcome.error
    // A contract-declared non-2xx is reported as a plain `{ statusCode, headers, body }`
    // value (not an Error). Wrap it so call sites get `instanceof Error` + the server's
    // message; anything already an Error (UnexpectedResponseError, request-validation
    // SchemaValidationError, a network fault) is rethrown unchanged.
    if (error instanceof Error) throw error
    const { statusCode, body } = error as { statusCode: number; body: unknown }
    throw new ApiError(statusCode, body)
  }
  return outcome.result!.body as SuccessBodyOf<T>
}

/** Curry {@link sendContract} over a client into the throw-on-error {@link ApiSend}. */
export function createSend(client: WretchInstance): ApiSend {
  return (contract, params) => sendContract(client, contract, params)
}

/**
 * Like {@link ApiSend} but augments the request with ambient headers not modelled by the
 * contract (the personal-subscription unlock password, mirroring how the bearer token
 * rides outside the wire body). `undefined` headers send unchanged.
 */
export type ApiSendWith = <T extends ApiContract>(
  extraHeaders: Record<string, string> | undefined,
  contract: T,
  params: SendParams<T>,
) => Promise<SuccessBodyOf<T>>

/** Curry {@link sendContract} with per-call ambient headers (see {@link ApiSendWith}). */
export function createSendWith(client: WretchInstance): ApiSendWith {
  return (extraHeaders, contract, params) =>
    sendContract(extraHeaders ? client.headers(extraHeaders) : client, contract, params)
}
