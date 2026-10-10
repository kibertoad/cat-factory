import type {
  MonorepoAdoptionExplorer,
  MonorepoAdoptionSide,
  MonorepoExplorationRequest,
} from '@cat-factory/kernel'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { renderSurveyFile } from '../prompts/monorepo-adoption.js'

// ---------------------------------------------------------------------------
// The read tools a monorepo adoption survey's model explores through: the repo's first
// PLATFORM-implemented inline tool loop (the only prior `tools` usage, `providerWebSearchTools`,
// is provider-hosted and runs no client-side loop).
//
// Two shapes are deliberate. The tools are bound PER SIDE rather than taking a `side` argument,
// so a path can never be ambiguous and a model cannot half-answer by naming the wrong repository
// with a plausible path. And every tool returns a STRING the model can read directly: the body
// under the exact key it may cite, or the sentence saying why there is none. A tool that threw,
// or that answered `{ error: … }` for the model to interpret, would turn one unreadable file
// into an aborted generation or a silent gap in the evidence.
//
// The tools own no budget and no bookkeeping of their own. Every call lands on the
// {@link MonorepoAdoptionExplorer}, which charges it, scrubs what it fetched and appends it to
// the survey's transcript, so what the model may cite and what the reviewer is shown are the
// same record by construction.
// ---------------------------------------------------------------------------

/** How a repository is named to the model in one side's tool descriptions. */
const SIDE_LABEL: Record<MonorepoAdoptionSide, string> = {
  monorepo: 'the existing monorepo the new service is landing in',
  template: 'the reference template the new service is created from',
}

/**
 * The one input every tool takes.
 *
 * A hand-written JSON Schema rather than the repo's usual valibot: valibot 1.x implements
 * Standard Schema but not its JSON Schema conversion, which is what the AI SDK needs to describe
 * a tool to a provider, so a valibot schema here fails at CALL time rather than at build time.
 * The `validate` hook keeps the runtime check, and the shape is one string.
 */
const pathInput = jsonSchema<{ path: string }>(
  {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Path relative to the repository root, with no leading slash (e.g. `services/billing/src`). Use an empty string for the root.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  {
    validate: (value) => {
      const path = (value as { path?: unknown } | null)?.path
      return typeof path === 'string'
        ? { success: true, value: { path } }
        : { success: false, error: new Error('`path` must be a string') }
    },
  },
)

/** The tool name a side's listing and reading are exposed under. */
function toolNames(side: MonorepoAdoptionSide): { list: string; read: string } {
  return { list: `list_${side}_directory`, read: `read_${side}_file` }
}

/** Run one read and render its answer as the text the model sees. */
async function answer(
  explorer: MonorepoAdoptionExplorer,
  request: MonorepoExplorationRequest,
): Promise<string> {
  const result = await explorer.explore(request)
  if (result.outcome === 'read' && result.key) return renderSurveyFile(result.key, result.body)
  // No content: the model is told WHY in the same breath, because "no such file", "the read
  // failed" and "the platform refused" need three different next moves from it, and a bare empty
  // string reads as the first whichever one actually happened.
  return `No content for \`${request.path || '.'}\`: ${result.note ?? 'nothing was returned'}. This is not a citable key.`
}

/**
 * The read tools for every side the survey can reach, bound to one explorer.
 *
 * A run with no linked reference template gets the monorepo pair only, so the model is never
 * offered a tool that can answer nothing: a capability that cannot be honoured is withheld
 * rather than wired up to refuse.
 */
export function monorepoExplorationTools(explorer: MonorepoAdoptionExplorer): ToolSet {
  const tools: ToolSet = {}
  for (const side of explorer.sides) {
    const names = toolNames(side)
    const label = SIDE_LABEL[side]
    tools[names.list] = tool({
      description:
        `List a directory in ${label}. Returns the entry names, one per line, with a trailing ` +
        `slash on subdirectories. Use it to see how a service lays out its source below its top ` +
        `level, or which workflows the CI directory actually holds.`,
      inputSchema: pathInput,
      execute: ({ path }) => answer(explorer, { side, kind: 'list', path }),
    })
    tools[names.read] = tool({
      description:
        `Read one file in ${label}. Returns its contents under the key you may cite as evidence. ` +
        `Long files are truncated, and the truncation says so.`,
      inputSchema: pathInput,
      execute: ({ path }) => answer(explorer, { side, kind: 'read', path }),
    })
  }
  return tools
}
