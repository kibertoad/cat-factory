import { createInterface } from 'node:readline'

// A minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0), enough
// for the agent CLIs to list and call tools. The harness image carries no runtime npm
// dependencies, so this is hand-written rather than the MCP SDK.

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** A tool's result: text for the model, flagged as an error when the call was refused. */
export interface McpToolResult {
  text: string
  isError?: boolean
}

export interface McpServerDefinition {
  name: string
  version: string
  tools: McpTool[]
  call(name: string, args: Record<string, unknown>): Promise<McpToolResult>
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

/** Answer one JSON-RPC message, or null for a notification (which gets no reply). */
export async function handleMcpMessage(
  server: McpServerDefinition,
  message: JsonRpcRequest,
): Promise<Record<string, unknown> | null> {
  const id = message.id ?? null
  const isNotification = message.id === undefined
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, text: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: text },
  })
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion:
          typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: server.tools })
    case 'tools/call': {
      const name = message.params?.name
      if (typeof name !== 'string' || !server.tools.some((t) => t.name === name)) {
        return fail(-32602, `unknown tool '${String(name)}'`)
      }
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const result = await server.call(name, args)
        return reply({
          content: [{ type: 'text', text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        })
      } catch (error) {
        return reply({
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        })
      }
    }
    default:
      return isNotification ? null : fail(-32601, `method not found: ${String(message.method)}`)
  }
}

/** Serve a definition on this process's stdin/stdout until stdin closes. */
export function serveMcpStdio(server: McpServerDefinition): void {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let message: JsonRpcRequest
    try {
      message = JSON.parse(line) as JsonRpcRequest
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
      )
      return
    }
    void handleMcpMessage(server, message).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
    })
  })
}
