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
import { describeThrown } from './operatorText.js'

export type DeploymentApiOptions = {
  baseUrl: string
  /** Injected so `test/deploymentApi.test.ts` can drive every answer with no network, as `IssueApi` is. */
  fetchImpl?: typeof fetch
}

/**
 * Cap on how much of the deployment's own body is carried, and it is deliberately generous.
 *
 * This is the deployment's account of itself, read from a terminal rather than from a toast: the
 * whole reason `deployment-health` relays it is that a fallback app's problem list and a proxy's
 * error page each name the fix. What it drops is SAID (see below), because a silent slice reads as
 * the whole of what the deployment answered.
 */
const MAX_BODY_CHARS = 2_000

/**
 * A root read the deployment ANSWERED, where the answer is unusable. Carries the STATUS, which is
 * the whole point of the class.
 *
 * Thrown as a plain `Error` this was the misdiagnosis this suite exists to remove, one layer up:
 * `probeFailure.ts` recognises an answered failure by its TYPE, so a non-2xx from `/health` (the
 * FIRST prerequisite, and the one an operator reads as causal) fell through to the unclassified
 * branch and was reported as "no HTTP status came back … suspect the check itself" one line under a
 * detail quoting the status. The two facts a remedy needs are the status and that this read sent no
 * credential, and neither survives being flattened into a message.
 */
export class DeploymentAnswerError extends Error {
  readonly status: number
  /**
   * HOW the answer was unusable, which decides what the reader is sent to look at.
   *
   * `refused` is a non-2xx: the status is the fact. `unparseable` is a 2xx whose body is not the
   * JSON the route answers, which is a different accusation entirely. Something that is not this
   * deployment (the SPA, a login portal, an intercepting proxy) answered in its place, and the
   * ADDRESS is back in question. Folding the two would send half the readers to the wrong half.
   */
  readonly answer: 'refused' | 'unparseable'
  readonly method: string
  readonly url: string

  constructor(args: {
    message: string
    status: number
    answer: 'refused' | 'unparseable'
    method: string
    url: string
    cause?: unknown
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause })
    this.name = 'DeploymentAnswerError'
    this.status = args.status
    this.answer = args.answer
    this.method = args.method
    this.url = args.url
  }
}

/** The deployment's own root reads: is it up, and if it is misconfigured, what does it say about it. */
export class DeploymentApi {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(options: DeploymentApiOptions) {
    this.#baseUrl = options.baseUrl
    this.#fetch = options.fetchImpl ?? fetch
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
      throw new DeploymentAnswerError({
        message: await describeDeploymentFailure(method, url, response),
        status: response.status,
        answer: 'refused',
        method,
        url,
      })
    }
    // A 2xx body that is not JSON is not a bug in this suite, which is what an escaping
    // `SyntaxError` reads as. It is the SPA (which serves a `/health` of its own), a login portal,
    // or a gateway answering in the deployment's place, and it is the one answered failure that
    // puts the ADDRESS back in question. Read as text first so the body can be reported at all.
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new DeploymentAnswerError({
        message:
          `${method} ${url} answered ${response.status} with a body that is not the JSON this ` +
          `route answers: ${cappedBody(text)}`,
        status: response.status,
        answer: 'unparseable',
        method,
        url,
        cause: error,
      })
    }
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
      return await this.#fetch(url, { method })
    } catch (error) {
      throw new Error(`${method} ${url} could not be reached`, { cause: error })
    }
  }
}

/**
 * Render a root-read failure with whatever the deployment said.
 *
 * What it deliberately does NOT append is the guidance that used to live here (both routes are
 * unauthenticated, so no credential is implicated, and the address is worth re-reading). That is a
 * REMEDY, and `probeFailure.ts` is what turns a thrown probe into one: as a tail on this message it
 * was the last 200 characters of a string a human-sized display cap then truncated away, which is
 * the whole of it gone for exactly the long-bodied 502 that most needed it.
 */
export async function describeDeploymentFailure(
  method: string,
  url: string,
  response: { status: number; text: () => Promise<string> },
): Promise<string> {
  let detail = ''
  try {
    detail = cappedBody(await response.text())
  } catch (error) {
    // A body read fails on a truncated or reset response, so the useful link is again one `.cause`
    // down, which is what `describeThrown` reads (and it names the absence rather than rendering
    // `<body unreadable: >` for a chain that said nothing).
    detail = `<body unreadable: ${describeThrown(error)}>`
  }
  return `${method} ${url} failed with ${response.status}: ${detail}`
}

/** The body, saying what it dropped: a silent slice reads as everything the deployment answered. */
function cappedBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body
  return `${body.slice(0, MAX_BODY_CHARS)} […${body.length - MAX_BODY_CHARS} more characters of the body]`
}
