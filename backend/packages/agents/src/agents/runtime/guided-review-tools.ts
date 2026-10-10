import { jsonSchema, tool, type ToolSet } from 'ai'

/**
 * Read access to one pull request, pinned to the commit under review. Every method answers with
 * the text the model reads: the content, or the sentence saying why there is none. The
 * implementation owns caps and the read budget, so the tools below stay thin.
 */
export interface GuidedReviewExplorer {
  listChangedFiles(): Promise<string>
  readDiff(path: string): Promise<string>
  readFile(request: GuidedReviewFileRequest): Promise<string>
  listDirectory(path: string): Promise<string>
}

export interface GuidedReviewFileRequest {
  path: string
  /** `head` is the commit under review, `base` the PR's target branch. */
  side: 'head' | 'base'
  startLine?: number
  endLine?: number
}

// Hand-written JSON Schemas: valibot does not convert to the JSON Schema the AI SDK sends a
// provider, so a valibot schema here would fail at call time (see monorepo-exploration-tools.ts).
const noInput = jsonSchema<Record<string, never>>(
  { type: 'object', properties: {}, additionalProperties: false },
  { validate: () => ({ success: true, value: {} }) },
)

const pathInput = jsonSchema<{ path: string }>(
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative path, no leading slash.' },
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

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

const fileInput = jsonSchema<GuidedReviewFileRequest>(
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository-relative path, no leading slash.' },
      side: {
        type: 'string',
        enum: ['head', 'base'],
        description: '`head` (default) reads the PR as reviewed; `base` reads the target branch.',
      },
      startLine: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
      endLine: { type: 'integer', minimum: 1, description: 'Last line to return, inclusive.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  {
    validate: (value) => {
      const raw = (value ?? {}) as Record<string, unknown>
      if (typeof raw.path !== 'string') {
        return { success: false, error: new Error('`path` must be a string') }
      }
      return {
        success: true,
        value: {
          path: raw.path,
          side: raw.side === 'base' ? 'base' : 'head',
          startLine: positiveInt(raw.startLine),
          endLine: positiveInt(raw.endLine),
        },
      }
    },
  },
)

/** The read tools a guided-review call explores its pull request through. */
export function guidedReviewTools(explorer: GuidedReviewExplorer): ToolSet {
  return {
    list_changed_files: tool({
      description: 'List every file the pull request changes, with its status and line counts.',
      inputSchema: noInput,
      execute: () => explorer.listChangedFiles(),
    }),
    read_diff: tool({
      description: "Read one changed file's patch, with hunk headers and line numbers.",
      inputSchema: pathInput,
      execute: ({ path }) => explorer.readDiff(path),
    }),
    read_file: tool({
      description:
        'Read a file in full or a line range, at the PR head or on the target branch. Lines are numbered.',
      inputSchema: fileInput,
      execute: (request) => explorer.readFile(request),
    }),
    list_directory: tool({
      description:
        'List the entries of a directory at the PR head. Use an empty path for the root.',
      inputSchema: pathInput,
      execute: ({ path }) => explorer.listDirectory(path),
    }),
  }
}
