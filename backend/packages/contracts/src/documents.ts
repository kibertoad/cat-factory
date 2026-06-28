import * as v from 'valibot'
import { blockTypeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Document-source integration wire contracts. A workspace can connect to one or
// more external document sources (Confluence, Notion, …), import requirement /
// RFC / PRD pages from them (projected locally), expand a page into board
// structure, or attach it to a task as agent context.
//
// The shapes here are deliberately source-agnostic: a `source` discriminator
// tags every connection and document, and each provider describes the
// credentials it needs via a {@link DocumentSourceDescriptor} so the UI can be
// rendered generically. Storage-only bookkeeping (the owning workspace, the
// credential bag, the soft-delete tombstone, the cached page body) is NOT on the
// wire — it lives in the core ports / D1 layer.
// ---------------------------------------------------------------------------

/** The external document sources cat-factory can link to. */
export const documentSourceKindSchema = v.picklist([
  'confluence',
  'notion',
  'github',
  'figma',
  'linear',
  'claude-design',
])
export type DocumentSourceKind = v.InferOutput<typeof documentSourceKindSchema>

// ---- Provider self-description (drives the generic connect UI) ------------

/** One credential a provider needs to connect (rendered as a form field). */
export const credentialFieldSchema = v.object({
  /** Stable key stored in the credential bag (e.g. `apiToken`). */
  key: v.string(),
  /** Human label for the form field. */
  label: v.string(),
  /** Optional helper text shown under the field. */
  help: v.optional(v.string()),
  /** Optional input placeholder. */
  placeholder: v.optional(v.string()),
  /** Render as a password input and never echo the value back. */
  secret: v.optional(v.boolean()),
})
export type CredentialField = v.InferOutput<typeof credentialFieldSchema>

/**
 * Everything the frontend needs to render a source's connect form and import
 * box without hard-coding any provider specifics.
 */
export const documentSourceDescriptorSchema = v.object({
  source: documentSourceKindSchema,
  /** Display name, e.g. `Confluence`. */
  label: v.string(),
  /** Lucide icon name for the source. */
  icon: v.string(),
  /** Credentials required to connect, in display order. */
  credentialFields: v.array(credentialFieldSchema),
  /** Label for the "import a page" input. */
  refLabel: v.string(),
  /** Placeholder for the "import a page" input. */
  refPlaceholder: v.string(),
  /**
   * Whether this source supports searching its catalogue by title/content (so
   * the UI offers a search box, not just a paste-a-URL field). Optional for
   * backward-compatibility; absent is treated as `false`.
   */
  searchable: v.optional(v.boolean()),
  /**
   * Who owns this source's stored credential. `'workspace'` (the default when
   * absent) — a single sealed credential shared by everyone in the workspace, the
   * model Notion/Confluence/Figma/Linear use. `'user'` — a **personal** credential
   * each member supplies for themselves (a per-user PAT), stored keyed by user id and
   * never shared; Claude Design uses this because the token authenticates as an
   * individual's account. The connect/import surface is otherwise identical, so the
   * UI just labels a `'user'` source as personal.
   */
  credentialScope: v.optional(v.picklist(['workspace', 'user'])),
})
export type DocumentSourceDescriptor = v.InferOutput<typeof documentSourceDescriptorSchema>
export type DocumentCredentialScope = NonNullable<DocumentSourceDescriptor['credentialScope']>

// ---- Connection + document projections ------------------------------------

/** A workspace's connection to a document source, as exposed to clients (never the credentials). */
export const documentConnectionSchema = v.object({
  source: documentSourceKindSchema,
  /** A human-friendly label for what we're connected to (site URL, workspace name). */
  label: v.string(),
  /** When the connection was established (epoch ms). */
  connectedAt: v.number(),
})
export type DocumentConnection = v.InferOutput<typeof documentConnectionSchema>

/** A page imported from a source, projected locally. */
export const sourceDocumentSchema = v.object({
  source: documentSourceKindSchema,
  /** The source's stable id for the page (Confluence page id, Notion page id). */
  externalId: v.string(),
  title: v.string(),
  /** Canonical URL of the page on the source. */
  url: v.string(),
  /** A short plain-text excerpt of the body (full body stays in storage). */
  excerpt: v.string(),
  /** The board block this document is attached to as context, if any. */
  linkedBlockId: v.nullable(v.string()),
  /** When this projection row was last refreshed (epoch ms). */
  syncedAt: v.number(),
})
export type SourceDocument = v.InferOutput<typeof sourceDocumentSchema>

/**
 * A single hit from searching a source's catalogue. A lean shape (no body) used
 * to populate a picker: selecting one imports it (by `externalId`) and links it
 * to a block. Distinct from {@link SourceDocument} — a hit is not yet projected
 * locally, so it carries no `linkedBlockId`/`syncedAt`.
 */
export const documentSearchResultSchema = v.object({
  source: documentSourceKindSchema,
  /** The source's stable id for the page (re-usable as an import ref). */
  externalId: v.string(),
  title: v.string(),
  /** Canonical URL of the page on the source. */
  url: v.string(),
  /** A short plain-text excerpt for the result row (may be empty). */
  excerpt: v.string(),
})
export type DocumentSearchResult = v.InferOutput<typeof documentSearchResultSchema>

// ---- Board plan (doc → structure) -----------------------------------------

/** A proposed task within a planned frame/module. */
export const planTaskSchema = v.object({
  title: v.string(),
  description: v.optional(v.string()),
})
export type PlanTask = v.InferOutput<typeof planTaskSchema>

/** A proposed module grouping tasks within a planned frame. */
export const planModuleSchema = v.object({
  name: v.string(),
  tasks: v.array(planTaskSchema),
})
export type PlanModule = v.InferOutput<typeof planModuleSchema>

/** A proposed top-level frame (service/api/…) with its modules and loose tasks. */
export const planFrameSchema = v.object({
  type: blockTypeSchema,
  title: v.string(),
  description: v.optional(v.string()),
  modules: v.array(planModuleSchema),
  tasks: v.array(planTaskSchema),
})
export type PlanFrame = v.InferOutput<typeof planFrameSchema>

/**
 * A proposed board structure extracted from an imported document. `planner`
 * records whether an LLM produced it or the deterministic heading parser did, so
 * the UI can label a preview honestly.
 */
export const documentBoardPlanSchema = v.object({
  source: documentSourceKindSchema,
  externalId: v.string(),
  planner: v.picklist(['llm', 'headings']),
  frames: v.array(planFrameSchema),
})
export type DocumentBoardPlan = v.InferOutput<typeof documentBoardPlanSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Connect a workspace to a document source. The `credentials` bag is validated
 * by the target provider (the `:source` is in the path), keeping the wire shape
 * uniform across providers.
 */
export const connectDocumentSourceSchema = v.object({
  credentials: v.record(
    v.string(),
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  ),
})
export type ConnectDocumentSourceInput = v.InferOutput<typeof connectDocumentSourceSchema>

/** Import (fetch + persist) a page by its id or a full page URL. */
export const importDocumentSchema = v.object({
  ref: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type ImportDocumentInput = v.InferOutput<typeof importDocumentSchema>

/** Search a source's catalogue by free text (title/content). */
export const searchDocumentsSchema = v.object({
  query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
})
export type SearchDocumentsInput = v.InferOutput<typeof searchDocumentsSchema>

/** Preview the board structure a page would expand into (no writes). */
export const planDocumentSchema = v.object({
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type PlanDocumentInput = v.InferOutput<typeof planDocumentSchema>

/**
 * Apply a previously-imported page's structure to the board. Without `frameId`
 * the plan's frames are spawned at the board root; with it, the plan's modules
 * and tasks are spawned inside that existing frame.
 */
export const spawnDocumentSchema = v.object({
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  frameId: v.optional(v.pipe(v.string(), v.minLength(1))),
})
export type SpawnDocumentInput = v.InferOutput<typeof spawnDocumentSchema>

/** Attach an imported page to a task as extra agent context. */
export const linkDocumentSchema = v.object({
  source: documentSourceKindSchema,
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  blockId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type LinkDocumentInput = v.InferOutput<typeof linkDocumentSchema>
