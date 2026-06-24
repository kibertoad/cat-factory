import * as v from 'valibot'
import { blockTypeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Service-blueprint wire contracts. The `blueprints` pipeline step decomposes a
// repository into one canonical board structure — a single service and the modules
// inside it — anchored to the codebase by explicit file/directory references on
// every node. The agent commits the decomposition into the repo (`blueprints/`)
// and returns the tree, which the engine reconciles onto the run's service frame.
//
// The shape is deliberately shallow and uniform (service → modules), mirroring the
// board's frame → module levels, so a blueprint reconciles directly onto the board
// and reads the same way an LLM would navigate the code. Individual tasks are
// authored by people, not derived from the map.
// ---------------------------------------------------------------------------

const nameField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))
const summaryField = v.pipe(v.string(), v.maxLength(2000))
/** A single codebase reference: a repo-relative file or directory path. */
const referenceField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400))
/** The file/directory paths a node maps to — what to read to work on it. */
const referencesField = v.array(referenceField)

// ---- Blueprint tree (service → modules) -----------------------------------

/** A cohesive area of the service (e.g. `auth`, `billing`). */
export const blueprintModuleSchema = v.object({
  /** Module name, typically the owning directory's domain (e.g. `Auth`). */
  name: nameField,
  /** One or two sentences on the module's responsibility. */
  summary: v.optional(summaryField, ''),
  /** Repo-relative paths the module owns (its directories / key files). */
  references: v.optional(referencesField, []),
})
export type BlueprintModule = v.InferOutput<typeof blueprintModuleSchema>

/** The repository as a single top-level service frame with its modules. */
export const blueprintServiceSchema = v.object({
  /** Board frame type the repo presents as (service / api / frontend / …). */
  type: blockTypeSchema,
  /** Human name for the service (defaults to the repo name). */
  name: nameField,
  /** One or two sentences describing the service overall. */
  summary: v.optional(summaryField, ''),
  /** Repo-relative entrypoints / root files (e.g. `package.json`, `src/index.ts`). */
  references: v.optional(referencesField, []),
  modules: v.optional(v.array(blueprintModuleSchema), []),
})
export type BlueprintService = v.InferOutput<typeof blueprintServiceSchema>

/** How a blueprint was produced: an LLM scan, or the deterministic tree heuristic. */
export const blueprintSourceSchema = v.picklist(['llm', 'heuristic'])
export type BlueprintSource = v.InferOutput<typeof blueprintSourceSchema>

/**
 * Counts of board blocks touched when the `blueprints` pipeline step materialises
 * (or reconciles) a decomposition onto the board: the service frame and its modules.
 */
export const boardScanSpawnResultSchema = v.object({
  /** Id of the service frame the blueprint was reconciled onto / spawned as. */
  frameId: v.string(),
  modules: v.number(),
})
export type BoardScanSpawnResult = v.InferOutput<typeof boardScanSpawnResultSchema>

// ---- In-repo blueprint artifact -------------------------------------------
// The Blueprinter agent persists the decomposition in the repository itself,
// under a dedicated folder, so it travels with the code and every agent can read
// it. The canonical, machine-readable file is `blueprint.json` (a BlueprintService
// tree); the markdown files are deterministic, human/agent-friendly renderings of
// the same tree (high-level overview + per-module deep dives).

/** Folder, relative to the repo root, that holds the persisted blueprint. */
export const BLUEPRINT_DIR = 'blueprints'
/** Canonical machine-readable blueprint file (the BlueprintService tree). */
export const BLUEPRINT_JSON_PATH = `${BLUEPRINT_DIR}/blueprint.json`
/** High-level overview markdown — the file agents read first. */
export const BLUEPRINT_OVERVIEW_PATH = `${BLUEPRINT_DIR}/overview.md`
/** Sub-folder holding one deep-dive markdown per module. */
export const BLUEPRINT_MODULES_DIR = `${BLUEPRINT_DIR}/modules`
/** Tiny manifest read for quick staleness checks without parsing the full tree. */
export const BLUEPRINT_VERSION_PATH = `${BLUEPRINT_DIR}/version.json`

/**
 * The lightweight `version.json` manifest committed alongside the blueprint. It
 * carries a monotonic version counter, the generation timestamp, and a content
 * hash of the canonical tree, so staleness checks are a tiny read rather than a
 * full parse of `blueprint.json`.
 */
export const blueprintVersionSchema = v.object({
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  generatedAt: v.string(),
  /** sha256 (hex) of the canonical `blueprint.json` bytes. */
  hash: v.string(),
  modules: v.pipe(v.number(), v.integer(), v.minValue(0)),
})
export type BlueprintVersion = v.InferOutput<typeof blueprintVersionSchema>

/**
 * Strictly parse an arbitrary value (e.g. the JSON read from `blueprint.json`, or
 * a tree returned by the Blueprinter container) into a {@link BlueprintService},
 * enforcing the exact schema shape. Unlike the harness's lenient coercion (which
 * silently drops malformed nodes), this **throws** on any shape violation, so a
 * bad payload can never be materialised onto the board. Use it at every trust
 * boundary that ingests a blueprint.
 */
export function parseBlueprintService(value: unknown): BlueprintService {
  return v.parse(blueprintServiceSchema, value)
}

/** Non-throwing variant: returns the parsed service or `undefined` when invalid. */
export function safeParseBlueprintService(value: unknown): BlueprintService | undefined {
  const result = v.safeParse(blueprintServiceSchema, value)
  return result.success ? result.output : undefined
}

/**
 * Render a {@link BlueprintService} as readable markdown for HUMAN + COMPANION
 * review — the descriptive counterpart of {@link renderSpecForReview}. A Blueprinter
 * is a container agent whose reviewable work product is the decomposition tree, not
 * its raw Pi transcript summary, so any companion grading it (today or in future)
 * must see the tree itself: the service, its entrypoints, and each module with its
 * responsibility and owned paths. Deterministic and dependency-free.
 */
export function renderBlueprintForReview(service: BlueprintService): string {
  const lines: string[] = [`# Service: ${service.name} (${service.type})`]
  if (service.summary) lines.push('', service.summary)
  if (service.references?.length) lines.push('', `Entrypoints: ${service.references.join(', ')}`)
  for (const mod of service.modules ?? []) {
    lines.push('', `## Module: ${mod.name}`)
    if (mod.summary) lines.push('', mod.summary)
    if (mod.references?.length) lines.push('', `Paths: ${mod.references.join(', ')}`)
  }
  return lines.join('\n')
}
