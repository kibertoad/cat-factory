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
  structuredContent?: Record<string, unknown>
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
 *
 * The JSON is COMPACT. Two-space indentation reads better to a human than to a model and costs
 * roughly a third of every result in whitespace, which on this surface is a third of an
 * agent-context snapshot; a host that wants it pretty can re-print the structured content it also
 * gets back.
 */
export function renderResult(
  value: unknown,
  options: { maxChars?: number; toolName: string; structured?: boolean },
): ToolResult {
  if (value === undefined) {
    // A tool that declares an output schema may not answer successfully with no structured content:
    // the caller's own client raises a PROTOCOL error for that, which is not shown to the model at
    // all. So an empty body from an operation the spec says answers with one takes the same
    // deployment-disagrees-with-the-schema route as a non-object below, rather than the honest
    // "returns no content" that belongs to a `204` operation (which declares no schema).
    return options.structured
      ? text(schemaMismatch(options.toolName, 'answered with no body at all'), true)
      : text('The request succeeded. This endpoint returns no content.')
  }
  const maxChars = options.maxChars ?? DEFAULT_MAX_RESULT_CHARS
  const json = JSON.stringify(value)
  if (json.length > maxChars) return text(overCap(options.toolName, json.length, maxChars), true)
  if (!options.structured) return text(json)
  if (!isJsonObject(value)) {
    // The tool DECLARES an output schema, so the protocol obliges a successful result to carry
    // structured content, and this value cannot be any. Reported as a failure of the call rather
    // than dropped to text, because it means the deployment answered with something the published
    // schema does not describe, and a caller silently getting the text form would never find out.
    return text(
      schemaMismatch(options.toolName, `returned a ${describeJson(value)}`) +
        ` The response was: ${json}`,
      true,
    )
  }
  // Both halves, which is what the protocol asks of a tool that returns structured content: the
  // text block is what a host with no structured-content support shows the model, and the
  // structured half is what an agent framework consumes without re-parsing prose.
  return { content: [{ type: 'text', text: json }], structuredContent: value }
}

/**
 * The message for a result that does not fit.
 *
 * A REFUSAL, where this used to render the first `maxChars` under a `[TRUNCATED]` note. Two reasons
 * it changed together: a tool declaring an `outputSchema` may not answer successfully without
 * structured content, and half an object cannot satisfy the schema it was cut out of, and the old
 * note itself told the model that what followed was not valid JSON and to narrow instead of reading
 * on, which is a hundred thousand characters of context spent to deliver that instruction.
 */
function overCap(toolName: string, length: number, maxChars: number): string {
  return (
    `${toolName} returned ${length} characters, over this server's ${maxChars}-character limit, ` +
    'so none of it was rendered: a response cut off mid-object is not valid JSON, and a model ' +
    'reading the surviving half summarises it as though it were whole. Narrow the request and ' +
    'call again (list endpoints take `limit` and `cursor`, and the debug text reads take ' +
    '`offset`), or raise CAT_FACTORY_MCP_MAX_RESULT_CHARS on this server.'
  )
}

/**
 * The message for a response the published output schema does not describe.
 *
 * One wording for both shapes of the same fault, because the fix is the same one either way: this
 * package and the deployment it is pointed at disagree about what an operation answers with, and
 * only an upgrade of one of them settles it. Reported as a failed CALL rather than left to the
 * caller's client, whose protocol-level refusal never reaches the model.
 */
function schemaMismatch(toolName: string, what: string): string {
  return (
    `${toolName} ${what}, where its published output schema describes an object. This is a ` +
    'mismatch between the deployment and this server, not something the arguments caused: check ' +
    'that the two are on compatible versions.'
  )
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeJson(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
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
