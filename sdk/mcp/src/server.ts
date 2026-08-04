import { CatFactoryClient } from '@cat-factory/sdk'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { type CatFactoryMcpOptions, selectTools } from './config.ts'
import { buildInstructions } from './instructions.ts'
import { renderError, renderResult } from './result.ts'
import { CAT_FACTORY_TOOLS, type CatFactoryTool } from './tools.generated.ts'

// The facade itself: an MCP server whose every tool is one call on `@cat-factory/sdk`.
//
// "Thin" is a design constraint rather than a description. This module decides which tools to
// list, how to turn one result or one failure into MCP content, and nothing else. Retries, auth,
// error classes, pagination, encoding and timeouts are the SDK's, which is what makes the tools
// behave identically to the same calls made from code — and what stops this becoming a second,
// quietly divergent implementation of the API's rules.
//
// The LOW-LEVEL `Server` rather than `McpServer`: the tool schemas are GENERATED as JSON Schema
// from the same spec the deployment validates against, and the high-level helper wants Zod
// schemas it would then convert back. Going through Zod would mean the model reads a schema that
// has been round-tripped through a second type system, and every gap in that conversion becomes a
// tool that misdescribes its own input.

/** The npm version, stamped into the SDK's `User-Agent` so a deployment can attribute calls. */
export const MCP_SERVER_VERSION = '0.5.0'

/** The name this server reports to a host. */
export const MCP_SERVER_NAME = 'cat-factory'

export interface CatFactoryMcpServer {
  /** The MCP server, ready to `connect()` to a transport. */
  server: Server
  /** The tools it exposes, after the group / read-only filters. */
  tools: readonly CatFactoryTool[]
}

/**
 * Build the MCP server for a deployment.
 *
 * The client is constructed HERE rather than taken as a parameter, and a test injects
 * `options.fetch` instead of a whole client. A client parameter would let a caller hand this one
 * pointed at a different deployment than the options describe, and would let a test pass one
 * without the `User-Agent` below — which is exactly the property most worth pinning, since it
 * only exists on the path a test would then not be exercising.
 */
export function createCatFactoryMcpServer(options: CatFactoryMcpOptions): CatFactoryMcpServer {
  const selection = selectTools(CAT_FACTORY_TOOLS, options)
  const { exposed } = selection
  const client = new CatFactoryClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    // Named so a deployment's request log attributes a call to the MCP facade rather than to
    // "some SDK user": the two have very different debugging stories, and an operator reading
    // an audit trail is entitled to know a model made the call.
    userAgent: `cat-factory-mcp/${MCP_SERVER_VERSION}`,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(selection),
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: exposed.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // Declared only where the operation has an object to describe (a `204` has none). A tool that
      // declares one is then OBLIGED to return `structuredContent` on every success, which is why
      // `renderResult` refuses an over-cap result rather than truncating it.
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: {
        title: tool.title,
        // `readOnlyHint` follows from the HTTP method. The other two come from the generated table
        // and are present only where the consequence is real money or a merged pull request; where
        // they are absent the protocol's own defaults apply, which are the cautious ones.
        readOnlyHint: tool.readOnly,
        ...(tool.hints
          ? { destructiveHint: tool.hints.destructive, idempotentHint: tool.hints.idempotent }
          : {}),
      },
    })),
  }))

  const byName = new Map(exposed.map((tool) => [tool.name, tool]))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const tool = byName.get(name)
    if (!tool) {
      // A name this server does not serve. Answered as a tool ERROR rather than a protocol one,
      // and phrased so the model can recover: on a filtered server the tool may genuinely exist
      // in the deployment, just not here.
      return renderError(
        new Error(
          `no such tool on this server. Available: ${[...byName.keys()].sort().join(', ')}`,
        ),
        { toolName: name },
      )
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    try {
      const result = await tool.invoke(client, args)
      return renderResult(result, {
        toolName: tool.name,
        structured: tool.outputSchema !== undefined,
        ...(options.maxResultChars !== undefined ? { maxChars: options.maxResultChars } : {}),
      })
    } catch (error) {
      // Every failure lands here, including one thrown while building the request. Nothing is
      // rethrown: a throw out of this handler becomes a JSON-RPC protocol error, which the host
      // treats as the server misbehaving and does not show the model — and the most useful thing
      // this facade ever returns is a 422 naming the field the model got wrong.
      return renderError(error, { toolName: tool.name })
    }
  })

  return { server, tools: exposed }
}
