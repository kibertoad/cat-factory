import * as v from 'valibot'
import { blockTypeSchema } from './primitives'

// ---------------------------------------------------------------------------
// Confluence integration wire contracts. These describe the connection a
// workspace holds to a Confluence Cloud site, the requirement/RFC/PRD pages it
// has imported (projected locally), and the proposed board structure a page can
// be expanded into. As with the GitHub and board entities, the worker produces
// these shapes and the core derives its domain types from them, so the API,
// core and frontend share one vocabulary.
//
// Storage-only bookkeeping (the workspace that owns a row, the API token, the
// soft-delete tombstone, the cached page body) is deliberately NOT on the wire —
// it lives in the core ports / D1 layer.
// ---------------------------------------------------------------------------

/** A workspace's Confluence connection, as exposed to clients (never the token). */
export const confluenceConnectionSchema = v.object({
  baseUrl: v.string(),
  accountEmail: v.string(),
  /** When the connection was established (epoch ms). */
  connectedAt: v.number(),
})
export type ConfluenceConnection = v.InferOutput<typeof confluenceConnectionSchema>

/** A Confluence page the workspace has imported, projected locally. */
export const confluenceDocumentSchema = v.object({
  pageId: v.string(),
  spaceKey: v.string(),
  title: v.string(),
  /** Canonical URL of the page on the Confluence site. */
  url: v.string(),
  /** Confluence page version number at import time. */
  version: v.number(),
  /** A short plain-text excerpt of the body (full body stays in storage). */
  excerpt: v.string(),
  /** The board block this document is attached to as context, if any. */
  linkedBlockId: v.nullable(v.string()),
  /** When this projection row was last refreshed (epoch ms). */
  syncedAt: v.number(),
})
export type ConfluenceDocument = v.InferOutput<typeof confluenceDocumentSchema>

// ---- Board plan (doc → structure) -----------------------------------------

/** A proposed task within a planned frame/module. */
export const planTaskSchema = v.object({
  title: v.string(),
  description: v.optional(v.string()),
  features: v.optional(v.array(v.string())),
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
 * A proposed board structure extracted from a Confluence document. `source`
 * records whether an LLM produced it or the deterministic heading parser did,
 * so the UI can label a preview honestly.
 */
export const confluenceBoardPlanSchema = v.object({
  pageId: v.string(),
  source: v.picklist(['llm', 'headings']),
  frames: v.array(planFrameSchema),
})
export type ConfluenceBoardPlan = v.InferOutput<typeof confluenceBoardPlanSchema>

// ---- Request bodies -------------------------------------------------------

/** Connect a workspace to a Confluence Cloud site with an API token. */
export const connectConfluenceSchema = v.object({
  baseUrl: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
  accountEmail: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  apiToken: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type ConnectConfluenceInput = v.InferOutput<typeof connectConfluenceSchema>

/** Import (fetch + persist) a page by its id or a full Confluence page URL. */
export const importConfluenceSchema = v.object({
  page: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type ImportConfluenceInput = v.InferOutput<typeof importConfluenceSchema>

/**
 * Apply a previously-imported page's structure to the board. Without `frameId`
 * the plan's frames are spawned at the board root; with it, the plan's modules
 * and tasks are spawned inside that existing frame.
 */
export const spawnConfluenceSchema = v.object({
  pageId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  frameId: v.optional(v.pipe(v.string(), v.minLength(1))),
})
export type SpawnConfluenceInput = v.InferOutput<typeof spawnConfluenceSchema>

/** Attach an imported page to a task as extra agent context. */
export const linkConfluenceTaskSchema = v.object({
  pageId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type LinkConfluenceTaskInput = v.InferOutput<typeof linkConfluenceTaskSchema>
