// ---------------------------------------------------------------------------
// Confluence integration. Requirements / RFCs / PRDs imported from Confluence
// can be expanded into board structure or attached to a task as agent context.
// These mirror the `@cat-factory/contracts` Confluence schemas.
// ---------------------------------------------------------------------------

import type { BlockType } from './domain'

/** A workspace's connection to a Confluence Cloud site (never carries the token). */
export interface ConfluenceConnection {
  baseUrl: string
  accountEmail: string
  /** When the connection was established (epoch ms). */
  connectedAt: number
}

/** A Confluence page imported into the workspace. */
export interface ConfluenceDocument {
  pageId: string
  spaceKey: string
  title: string
  url: string
  version: number
  /** Short plain-text preview of the page body. */
  excerpt: string
  /** The board block this document is attached to as context, if any. */
  linkedBlockId: string | null
  syncedAt: number
}

/** A proposed task within a planned frame/module. */
export interface PlanTask {
  title: string
  description?: string
  features?: string[]
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

/** A board structure extracted from a Confluence document. */
export interface ConfluenceBoardPlan {
  pageId: string
  /** Whether an LLM produced the plan or the deterministic heading parser did. */
  source: 'llm' | 'headings'
  frames: PlanFrame[]
}

/** Counts of blocks created by spawning a plan onto the board. */
export interface SpawnResult {
  frames: number
  modules: number
  tasks: number
}
