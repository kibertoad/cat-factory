import type { TaskType } from '@cat-factory/contracts'
import { DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS } from './collections/style.js'

// ---------------------------------------------------------------------------
// Per-TASK-TYPE default best-practice fragment ids.
//
// The fragments a NEW task of a given type (`document`, `review`, `feature`, …) is
// pre-seeded with at creation. The board service unions these onto a task's
// `fragmentIds` when it is created (alongside whatever the task inherits from its
// service or an explicit create-form pick), so every new task of that type starts with
// the guidance without any per-block or per-workspace configuration.
//
// This is the deployment-level PROGRAMMATIC seam — a module-global registry mirroring
// `registerPromptFragment` and `registerDocTemplate`. A deployment adds its own custom
// fragments via `registerPromptFragments(...)` (universal pool) and then declares them as
// the default for a task type via `registerTaskTypeDefaultFragments('review', [...ids])`,
// so e.g. every new documentation or review task starts with that org's guidance. The
// call happens once at startup (an import side effect in the deployment entry, before
// `start()` / `startLocal()`), exactly like `registerPromptFragments`.
//
// The shipped `document` writing-style defaults (`DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`)
// are the ONLY built-in per-type default; they are always applied for a document task and
// union with any registered ids, so registering document defaults augments (never wipes)
// the writing-style guidance. When nothing is registered, behaviour is unchanged.
// ---------------------------------------------------------------------------

/** The built-in per-task-type defaults shipped with the catalog (today: document only). */
const BUILTIN_TASK_TYPE_DEFAULTS: Partial<Record<TaskType, readonly string[]>> = {
  document: DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
}

/** Deployment-registered per-task-type default fragment ids (added to the built-ins). */
const registered = new Map<TaskType, readonly string[]>()

/**
 * Register the default fragment ids for a task type. Every NEW task of `taskType` created
 * on the board then starts with these fragments (unioned with the built-in defaults and
 * whatever the task inherits). Re-registering the same task type REPLACES its registered
 * set. The ids reference the universal fragment pool (built-in catalog plus any
 * `registerPromptFragment`-registered fragments); an unresolvable id is simply skipped
 * when bodies are composed at run time, so registration order with `registerPromptFragment`
 * does not matter.
 */
export function registerTaskTypeDefaultFragments(
  taskType: TaskType,
  fragmentIds: Iterable<string>,
): void {
  registered.set(taskType, [...fragmentIds])
}

/** Drop all registered per-task-type defaults. Intended for tests that exercise registration. */
export function clearRegisteredTaskTypeDefaultFragments(): void {
  registered.clear()
}

/**
 * The effective default fragment ids a new task of `taskType` is seeded with: the built-in
 * defaults for the type (the document writing-style set, else none) unioned with any
 * deployment-registered ids, deduped and order-stable (built-ins first). Empty when the
 * type has no built-in and nothing is registered.
 */
export function defaultFragmentIdsForTaskType(taskType: TaskType): string[] {
  const builtin = BUILTIN_TASK_TYPE_DEFAULTS[taskType] ?? []
  const custom = registered.get(taskType) ?? []
  if (custom.length === 0) return [...builtin]
  return [...new Set([...builtin, ...custom])]
}
