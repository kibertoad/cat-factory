import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ENV_VARS, type EnvReadDeps, optionsFromEnv } from './config.ts'
import { createCatFactoryMcpServer } from './server.ts'

// Booting the stdio server, separated from the `cat-factory-mcp` executable next door so it can be
// driven by a test.
//
// One rule governs everything here: STDOUT IS THE PROTOCOL. A stdio MCP server speaks
// newline-delimited JSON-RPC over stdout, so a stray `console.log` (a banner, a warning, a debug
// line) corrupts the stream and the host reports a server that connected and then broke. Every
// human-readable byte goes through `log`, which the executable points at stderr and a test points at
// an array. That is the reason for the injection: a rule about which stream is written to cannot be
// pinned by a test that has no way to see the wrong one being used.

/** What the boot needs from the process around it. */
export interface StdioBootDeps extends EnvReadDeps {
  /** The environment the options are read from. */
  env: Record<string, string | undefined>
  /** Where every human-readable byte goes. NEVER stdout. */
  log: (line: string) => void
  /**
   * Attach the built server to a transport.
   *
   * Defaults to the real stdio transport. A test overrides it rather than the whole server, so
   * everything up to and including the connect ordering below is the code that actually ships.
   */
  connect?: (server: Server) => Promise<void>
}

/** What the boot reports back, so a caller can say it in its own words. */
export interface StdioBootResult {
  toolCount: number
  baseUrl: string
}

/**
 * Build the server from the environment and connect it.
 *
 * The transport is connected BEFORE the ready line is written. A host reads that line as "this
 * server is up"; writing it first would mean announcing readiness and then failing to connect, which
 * is the one ordering that produces a log claiming success next to a server that never served.
 */
export async function bootStdioServer(deps: StdioBootDeps): Promise<StdioBootResult> {
  const options = optionsFromEnv(deps.env, { readSecretFile: deps.readSecretFile })
  const { server, tools } = createCatFactoryMcpServer(options)
  const connect = deps.connect ?? ((built: Server) => built.connect(new StdioServerTransport()))
  await connect(server)
  deps.log(`cat-factory MCP server ready: ${tools.length} tools against ${options.baseUrl}\n`)
  return { toolCount: tools.length, baseUrl: options.baseUrl }
}

/**
 * What to write when the boot failed.
 *
 * It names the configuration rather than only the error, because every way this fails is a
 * configuration problem and the operator reading it is looking at a host's config file: the cause
 * says what is wrong and the second line says where to fix it.
 */
export function startupFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (
    `cat-factory MCP server failed to start: ${message}\n` +
    `Configure it with ${ENV_VARS.baseUrl} and either ${ENV_VARS.apiKey} or ${ENV_VARS.apiKeyFile}.\n`
  )
}
