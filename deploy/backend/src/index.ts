// Backend deployment entry point.
//
// This is the example *deployment* of the reusable @cat-factory/worker library.
// It contains no logic of its own: it re-exports the library's default
// fetch/scheduled/queue handler and the Durable Object + Workflow classes by the
// exact names this deployment's wrangler.toml binds. Wrangler bundles this module
// (esbuild) and resolves the implementations from the installed package.
//
// To run your own deployment you only need this re-export plus wrangler.toml and
// your secrets/vars — swap the workspace dependency in package.json for the
// published version, e.g. "@cat-factory/worker": "^0.1.0".
export {
  default,
  ExecutionWorkflow,
  GitHubBackfillWorkflow,
  BootstrapWorkflow,
  ExecutionContainer,
  WorkspaceEventsHub,
} from '@cat-factory/worker'
