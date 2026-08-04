#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ENV_VARS, optionsFromEnv } from './config.ts'
import { createCatFactoryMcpServer } from './server.ts'

// The `cat-factory-mcp` executable: the stdio server an MCP host spawns.
//
// One rule governs everything in this file: STDOUT IS THE PROTOCOL. A stdio MCP server speaks
// newline-delimited JSON-RPC over stdout, so a stray `console.log` — a banner, a warning, a
// debug line — corrupts the stream and the host reports a server that connected and then broke.
// Every human-readable byte this process writes goes to stderr, which hosts capture as logs.

async function main(): Promise<void> {
  const options = optionsFromEnv(process.env)
  const { server, tools } = createCatFactoryMcpServer(options)
  await server.connect(new StdioServerTransport())
  process.stderr.write(
    `cat-factory MCP server ready: ${tools.length} tools against ${options.baseUrl}\n`,
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `cat-factory MCP server failed to start: ${message}\n` +
      `Configure it with ${ENV_VARS.baseUrl} and ${ENV_VARS.apiKey}.\n`,
  )
  // Refusing to start is the point: a server that comes up without credentials would be listed by
  // the host as connected and would then fail every call, which costs a model several turns to
  // work out and reads to a user as the platform being broken.
  process.exit(1)
})
