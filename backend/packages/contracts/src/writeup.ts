import * as v from 'valibot'
import { type DefinitionParseResult, describeValibotIssues } from './project-definitions.js'

// ---------------------------------------------------------------------------
// The WRITEUP task type: a document stage. Its agent composes the results of the stages it reads
// into one Markdown document (a knowledge document, a handoff), referencing the binary artifacts
// those results hold. The platform checks what the agent cannot be trusted to state about its own
// work: which sections of the stage's outline the document lacks, and which artifacts it names
// that no result it read holds. Design: `docs/initiatives/staged-project-definitions.md`.
// ---------------------------------------------------------------------------

/** The built-in task type a document stage runs as. */
export const WRITEUP_TASK_TYPE = 'writeup'

/** The agent kind a document stage's task dispatches. */
export const PROJECT_WRITER_AGENT_KIND = 'project-writer'

/** The body schema version a writeup is written in today. */
export const WRITEUP_SCHEMA_VERSION = 1

export const WRITEUP_MARKDOWN_MAX = 200_000
export const WRITEUP_BRIEF_MAX = 20_000
export const WRITEUP_OUTLINE_MAX = 30
export const WRITEUP_ARTIFACTS_MAX = 50
const SHORT_MAX = 2000

const short = v.pipe(v.string(), v.trim(), v.maxLength(SHORT_MAX))
const heading = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/** What a document stage writes: a brief, and the sections the document must have. */
export const writeupStageConfigSchema = v.object({
  brief: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(WRITEUP_BRIEF_MAX)),
  /** Section headings the document must carry, in order. */
  outline: v.optional(v.pipe(v.array(heading), v.maxLength(WRITEUP_OUTLINE_MAX)), []),
})
export type WriteupStageConfig = v.InferOutput<typeof writeupStageConfigSchema>

/** An artifact the document references: one a result the stage read holds. */
export const writeupArtifactSchema = v.object({
  ref: v.pipe(v.string(), v.minLength(1)),
  caption: short,
})

/** The document as recorded. */
export const writeupSchema = v.object({
  title: heading,
  /** A few sentences on what the document covers. */
  summary: short,
  markdown: v.pipe(v.string(), v.maxLength(WRITEUP_MARKDOWN_MAX)),
  artifacts: v.pipe(v.array(writeupArtifactSchema), v.maxLength(WRITEUP_ARTIFACTS_MAX)),
  /** Outline sections the document has no heading for, as the platform found. */
  missingSections: v.optional(v.array(v.string()), []),
  /** Artifacts the agent named that no result the stage read holds, left out of `artifacts`. */
  droppedArtifacts: v.optional(v.array(v.string()), []),
})
export type Writeup = v.InferOutput<typeof writeupSchema>

/** What the writer agent is handed. */
export interface WriteupBrief {
  brief: string
  outline: string[]
  /** The artifacts the results it reads hold, the only ones it may reference. */
  artifacts: string[]
  /** The document this stage last recorded, for a rerun to revise rather than restart. */
  prior?: Writeup
  /** The document an earlier, stopped dispatch of this task drafted, to continue from. */
  checkpoint?: Writeup
}

function parsed<T>(schema: v.GenericSchema<unknown, T>, input: unknown): DefinitionParseResult<T> {
  const result = v.safeParse(schema, input)
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, issues: describeValibotIssues(result.issues) }
}

export const parseWriteupStageConfig = (input: unknown) => parsed(writeupStageConfigSchema, input)
export const parseWriteup = (input: unknown) => parsed(writeupSchema, input)

const normalizedHeading = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** The outline sections the document has no Markdown heading for, outside code fences. */
export function missingOutlineSections(outline: readonly string[], markdown: string): string[] {
  const headings = new Set<string>()
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const opening = /^(`{3,}|~{3,})/.exec(line)?.[1]
    if (opening) {
      if (fence === null) fence = opening
      else if (line.startsWith(fence)) fence = null
      continue
    }
    const match = fence === null ? /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line) : null
    if (match) headings.add(normalizedHeading(match[1]!))
  }
  return outline.filter((section) => !headings.has(normalizedHeading(section)))
}

/**
 * The document as the platform records it: artifacts no result the stage read holds dropped and
 * named, and the outline sections it lacks named.
 */
export function settleWriteup(
  reply: Writeup,
  outline: readonly string[],
  allowedArtifacts: readonly string[],
): Writeup {
  const allowed = new Set(allowedArtifacts)
  return {
    ...reply,
    artifacts: reply.artifacts.filter((a) => allowed.has(a.ref)),
    droppedArtifacts: reply.artifacts.filter((a) => !allowed.has(a.ref)).map((a) => a.ref),
    missingSections: missingOutlineSections(outline, reply.markdown),
  }
}
