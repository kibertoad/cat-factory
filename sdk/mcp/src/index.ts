// `@cat-factory/mcp-server` — a Model Context Protocol facade over the cat-factory public API.
//
// The tool table is GENERATED from `docs/openapi.json` (the same spec the four SDK clients are
// generated from), and every tool is one call on the hand-written `@cat-factory/sdk` transport. So
// the facade cannot drift from the surface it exposes, and it re-implements none of the SDK's
// behaviour — retries, auth, error classes, pagination and encoding are all the SDK's.
//
// Run it as a stdio server with the `cat-factory-mcp` binary, or mount it on your own transport
// with `createCatFactoryMcpServer`.

export {
  createCatFactoryMcpServer,
  type CatFactoryMcpServer,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from './server.ts'
export {
  type CatFactoryMcpOptions,
  ENV_VARS,
  type EnvReadDeps,
  optionsFromEnv,
  selectTools,
  type ToolSelection,
} from './config.ts'
export { buildInstructions } from './instructions.ts'
export { DEFAULT_MAX_RESULT_CHARS, renderError, renderResult, type ToolResult } from './result.ts'
export {
  bootStdioServer,
  type StdioBootDeps,
  type StdioBootResult,
  startupFailureMessage,
} from './stdio.ts'
export {
  CAT_FACTORY_OMITTED_OPERATIONS,
  CAT_FACTORY_TOOL_GROUPS,
  CAT_FACTORY_TOOLS,
  type CatFactoryOmittedOperation,
  type CatFactoryTool,
} from './tools.generated.ts'
