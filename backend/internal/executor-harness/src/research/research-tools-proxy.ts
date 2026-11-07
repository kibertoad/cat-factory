import { createInterface } from 'node:readline'

// The stdio side of the research tool server: the agent CLI spawns this, and it forwards each
// newline-delimited JSON-RPC message to the server the harness process hosts on loopback. It
// holds no credential value, only the endpoint and the per-job token (see
// research-tools-server.ts for why the values stay in the harness process).

export const RESEARCH_TOOLS_URL_ENV = 'CF_RESEARCH_TOOLS_URL'
export const RESEARCH_TOOLS_TOKEN_ENV = 'CF_RESEARCH_TOOLS_TOKEN'

export interface ProxyEndpoint {
  url: string
  token: string
}

/** Forward one message and return the reply line, or null for a notification. */
export async function forwardMcpLine(
  endpoint: ProxyEndpoint,
  line: string,
): Promise<string | null> {
  let id: unknown = null
  try {
    id = (JSON.parse(line) as { id?: unknown }).id ?? null
  } catch {
    // The server answers a malformed line with a parse error of its own.
  }
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: line,
    })
    if (res.status === 204) return null
    if (!res.ok) throw new Error(`the research tool server answered HTTP ${res.status}`)
    return (await res.text()).trim()
  } catch (error) {
    if (id === null) return null
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } })
  }
}

function main(): void {
  const url = process.env[RESEARCH_TOOLS_URL_ENV]
  const token = process.env[RESEARCH_TOOLS_TOKEN_ENV]
  if (!url || !token) {
    process.stderr.write(`${RESEARCH_TOOLS_URL_ENV} and ${RESEARCH_TOOLS_TOKEN_ENV} are required\n`)
    process.exit(1)
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (!line.trim()) return
    void forwardMcpLine({ url, token }, line).then((reply) => {
      if (reply) process.stdout.write(`${reply}\n`)
    })
  })
}

if (process.argv[1]?.endsWith('research-tools-proxy.js')) main()
