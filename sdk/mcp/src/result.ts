import { CatFactoryApiError, CatFactoryError } from '@cat-factory/sdk'

// Turning one SDK call into one MCP tool result. Two rules, and both are about a MODEL being the
// reader: what it gets back has to be honest about size, and a refusal has to say enough for the
// model to fix its own call rather than retry the same one.

/**
 * The default ceiling on one tool result, in characters.
 *
 * A tool result is spent from the model's context window, and this surface has endpoints that can
 * legitimately answer with a megabyte (a run's LLM-call bodies, an agent-context snapshot). The
 * endpoints that CAN be large all take `limit` / `cursor` / `offset`, so the cap is not a loss of
 * capability — but it has to be stated rather than applied silently, because a quietly shortened
 * answer is one a model reports on as though it were the whole thing.
 */
export const DEFAULT_MAX_RESULT_CHARS = 100_000

/**
 * The MCP content shape, declared here so this module needs no protocol types (which keeps it
 * unit-testable against plain objects).
 *
 * A type ALIAS, not an interface, and that is load-bearing rather than style: only an alias of an
 * object literal gets TypeScript's implicit index signature, and the protocol's result type is an
 * open `{ [x: string]: unknown }` record. An interface fails to assign to it, and the fix would
 * otherwise be a cast at the one place a wrong shape should be caught. The generated SDK's query
 * types are an alias for exactly this reason.
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function text(value: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: 'text', text: value }], isError: true }
    : { content: [{ type: 'text', text: value }] }
}

/**
 * Render an SDK result as tool content.
 *
 * A `204` endpoint resolves to `undefined`, which is a real answer ("it worked, there is nothing
 * to return") and not an empty one, so it is SAID rather than rendered as `undefined` or as an
 * empty string a model would read as a failure.
 */
export function renderResult(
  value: unknown,
  options: { maxChars?: number; toolName: string },
): ToolResult {
  if (value === undefined) {
    return text('The request succeeded. This endpoint returns no content.')
  }
  const maxChars = options.maxChars ?? DEFAULT_MAX_RESULT_CHARS
  const json = JSON.stringify(value, null, 2)
  if (json.length <= maxChars) return text(json)
  // The note goes FIRST and names the truncation in the same breath as the remedy: what follows
  // is no longer parseable JSON, and a model that starts reading at the top must know that before
  // it starts, not after it has already summarised half a document as complete.
  const dropped = json.length - maxChars
  const note =
    `[TRUNCATED] \`${options.toolName}\` returned ${json.length} characters, over this server's ` +
    `${maxChars}-character limit; the last ${dropped} were dropped. What follows is the beginning ` +
    'of the response and is NOT valid JSON. Narrow the request instead of reading on: list ' +
    'endpoints take `limit` and `cursor`, and the debug text reads take `offset`.'
  return text(`${note}\n\n${json.slice(0, maxChars)}`)
}

/**
 * Render a failure as tool content.
 *
 * `isError` rather than a thrown JSON-RPC error, deliberately: a protocol error says the SERVER
 * misbehaved and is not shown to the model, where a failed tool call is information the model is
 * meant to act on. A 422 naming the field it got wrong is the most useful thing this facade ever
 * returns, and throwing would hide it.
 *
 * The deployment's own vocabulary is passed through verbatim — `code`, `details.reason` and the
 * per-field `issues` — because that is what the API guide documents and what a caller (human or
 * model) can look up. Nothing here re-words a refusal into a friendlier one that means less.
 */
export function renderError(error: unknown, options: { toolName: string }): ToolResult {
  if (error instanceof CatFactoryApiError) {
    const lines = [
      `${options.toolName} failed: HTTP ${error.status} (${error.code})`,
      error.message,
    ]
    if (error.issues.length > 0) {
      lines.push(
        'Fields the deployment rejected:',
        ...error.issues.map((issue) => `  - ${issue.path ?? '(body)'}: ${issue.message}`),
      )
    }
    if (error.details !== undefined && error.details !== null) {
      lines.push(`details: ${JSON.stringify(error.details)}`)
    }
    // The request id is what a human correlates with the deployment's logs; it is worth more in
    // this string than everything else here when the failure turns out to be server-side.
    if (error.requestId) lines.push(`requestId: ${error.requestId}`)
    return text(lines.join('\n'), true)
  }
  if (error instanceof CatFactoryError) {
    // A transport-level failure (connection, timeout, an undecodable body). The SDK has already
    // spent its retry budget by the time this is reached, so "try again" is the caller's decision
    // and not a thing to imply here.
    return text(`${options.toolName} failed: ${error.name}: ${error.message}`, true)
  }
  // Anything else is this facade's own fault — most often an argument the tool's schema declares
  // required and the host did not send. Named as such so the model retries with the argument
  // rather than concluding the deployment is broken.
  const message = error instanceof Error ? error.message : String(error)
  return text(`${options.toolName} could not be called: ${message}`, true)
}
