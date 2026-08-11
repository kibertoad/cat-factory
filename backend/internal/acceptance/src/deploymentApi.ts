// The deployment ROOT reads: `GET /health` and `GET /auth/config`. Everything else this suite does
// goes through the published SDK against `/api/v1`.
//
// These two are here rather than on the public surface because both have to answer for a deployment
// whose configuration FAILED to validate. Such a backend serves a fallback app that answers 503 on
// every other route, `/api/v1` included, so both take no credential by design: a key-authenticated
// health check cannot describe a deployment too broken to authenticate a key, which is exactly the
// state worth describing.
//
// That reasoning is also the rule for adding to this file: it does not extend to anything scoped to
// a WORKSPACE. A caller acting on one has a key, so that is a public endpoint.

import type { ConfigProblem } from '@cat-factory/contracts'
import { getErrorMessage } from '@cat-factory/kernel'

export type DeploymentApiOptions = {
  baseUrl: string
}

/** The deployment's own root reads: is it up, and if it is misconfigured, what does it say about it. */
export class DeploymentApi {
  readonly #baseUrl: string

  constructor(options: DeploymentApiOptions) {
    this.#baseUrl = options.baseUrl
  }

  /**
   * The deployment's own health verdict.
   *
   * `misconfigured` is the value that earns this call: a backend that failed its own config
   * validation serves a FALLBACK app which answers every other route with a 503, so without this
   * probe the suite's first real call reports "503 from /api/v1/me" and an operator goes looking at
   * their API key.
   */
  health(): Promise<{ status: string }> {
    return this.#request<{ status: string }>('GET', '/health')
  }

  /**
   * The problem list a misconfigured deployment publishes about ITSELF.
   *
   * Only meaningful when `health()` said `misconfigured`; on a healthy backend the field is absent
   * and this answers an empty list. Each entry names the variable, what breaks without it and how to
   * fill it, so the suite reports the backend's own diagnosis rather than paraphrasing a 503.
   */
  async configProblems(): Promise<readonly ConfigProblem[]> {
    const config = await this.#request<{ misconfigured?: { problems?: ConfigProblem[] } }>(
      'GET',
      '/auth/config',
    )
    return config.misconfigured?.problems ?? []
  }

  async #request<T>(method: string, path: string): Promise<T> {
    const url = `${this.#baseUrl}${path}`
    const response = await this.#reach(method, url)
    if (!response.ok) {
      throw new Error(await describeDeploymentFailure(method, url, response))
    }
    return (await response.json()) as T
  }

  /**
   * `fetch`, with the REQUEST named on a transport failure and the thrown value kept as the `cause`.
   *
   * Both halves earn their place. The name is what the non-2xx path already gives
   * (`describeDeploymentFailure` opens with `${method} ${url}`), and without it a refused connection
   * reported an address with no indication of which read wanted it. Keeping the original as `cause`
   * is what makes the wrapper safe to add at all: `probeFailure.ts` classifies by walking the chain
   * DEEPEST-FIRST, so a `new Error(message)` that dropped the cause would turn a diagnosable
   * `ECONNREFUSED` into `unknown` and cost the very remedy this exists to reach.
   */
  async #reach(method: string, url: string): Promise<Response> {
    try {
      return await fetch(url, { method })
    } catch (error) {
      throw new Error(`${method} ${url} could not be reached`, { cause: error })
    }
  }
}

/**
 * Render a root-read failure with whatever the deployment said.
 *
 * There is no auth hint to add: both routes are unauthenticated, so a non-2xx here means the
 * deployment is not answering rather than that the caller lacks a credential. Saying so keeps this
 * message from sending someone to check a key that was never involved.
 */
export async function describeDeploymentFailure(
  method: string,
  url: string,
  response: { status: number; text: () => Promise<string> },
): Promise<string> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 2000)
  } catch (error) {
    // A body read fails on a truncated or reset response, so the useful link is again one `.cause`
    // down. `getErrorMessage` answers EMPTY for an error with nothing to say, which is what the
    // fallback is for: `<body unreadable: >` states less than naming the absence.
    detail = `<body unreadable: ${getErrorMessage(error) || 'no reason reported'}>`
  }
  return (
    `${method} ${url} failed with ${response.status}: ${detail}\n` +
    'Both deployment root reads are unauthenticated, so this is the deployment not answering ' +
    'rather than a credential problem. Check that it is running and that CAT_FACTORY_BASE_URL ' +
    'names the BACKEND rather than the SPA.'
  )
}
