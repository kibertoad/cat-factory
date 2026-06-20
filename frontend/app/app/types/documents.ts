// ---------------------------------------------------------------------------
// Document-source integration. Requirements / RFCs / PRDs imported from external
// sources (Confluence, Notion, …) can be expanded into board structure or
// attached to a task as agent context. These mirror the `@cat-factory/contracts`
// document schemas; the abstraction is source-agnostic, keyed by `source`.
// ---------------------------------------------------------------------------

import type { BlockType } from './domain'

/** The external document sources cat-factory can link to. */
export type DocumentSourceKind = 'confluence' | 'notion' | 'github'

/** One credential a provider needs to connect (rendered as a form field). */
export interface CredentialField {
  key: string
  label: string
  help?: string
  placeholder?: string
  secret?: boolean
}

/** A source's self-description: drives the generic connect + import UI. */
export interface DocumentSourceDescriptor {
  source: DocumentSourceKind
  label: string
  /** Lucide icon name for the source. */
  icon: string
  credentialFields: CredentialField[]
  refLabel: string
  refPlaceholder: string
  /** Whether the source supports searching its catalogue by title/content. */
  searchable?: boolean
}

/** A workspace's connection to a document source (never carries credentials). */
export interface DocumentConnection {
  source: DocumentSourceKind
  /** Human-friendly label for what we're connected to (site URL, workspace name). */
  label: string
  /** When the connection was established (epoch ms). */
  connectedAt: number
}

/** A page imported from a source into the workspace. */
export interface SourceDocument {
  source: DocumentSourceKind
  /** The source's stable id for the page. */
  externalId: string
  title: string
  url: string
  /** Short plain-text preview of the page body. */
  excerpt: string
  /** The board block this document is attached to as context, if any. */
  linkedBlockId: string | null
  syncedAt: number
}

/** A lean hit from searching a document source's catalogue (not yet imported). */
export interface DocumentSearchResult {
  source: DocumentSourceKind
  /** The source's stable id for the page (re-usable as an import ref). */
  externalId: string
  title: string
  url: string
  /** Short plain-text preview (may be empty). */
  excerpt: string
}

/** A proposed task within a planned frame/module. */
export interface PlanTask {
  title: string
  description?: string
}

/** A proposed module grouping tasks within a planned frame. */
export interface PlanModule {
  name: string
  tasks: PlanTask[]
}

/** A proposed top-level frame with its modules and loose tasks. */
export interface PlanFrame {
  type: BlockType
  title: string
  description?: string
  modules: PlanModule[]
  tasks: PlanTask[]
}

/** A board structure extracted from an imported document. */
export interface DocumentBoardPlan {
  source: DocumentSourceKind
  externalId: string
  /** Whether an LLM produced the plan or the deterministic heading parser did. */
  planner: 'llm' | 'headings'
  frames: PlanFrame[]
}

/** Counts of blocks created by spawning a plan onto the board. */
export interface SpawnResult {
  frames: number
  modules: number
  tasks: number
}
