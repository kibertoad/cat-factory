import type { TaskType } from '@cat-factory/contracts'
import { DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS } from './collections/style.js'

// ---------------------------------------------------------------------------
// The BUILT-IN per-task-type default best-practice fragment ids.
//
// The fragments a NEW task of a given type (`document`, `review`, `feature`, …) is pre-seeded
// with at creation. The board service unions these onto a task's `fragmentIds` when it is created
// (alongside whatever the task inherits from its service or an explicit create-form pick), so
// every new task of that type starts with the guidance without any per-block or per-workspace
// configuration.
//
// A DEPLOYMENT declares its own through the app-owned registry
// (`promptFragmentRegistry.registerTaskTypeDefaults('review', [...ids])`), which is what this
// module used to hold as a second module global beside the fragment pool, with the identical
// two-physical-copies hazard. The built-in sets below are installed onto that same registry by
// `promptFragmentRegistryWithBuiltins()`, through the same public method, so the platform and a
// consumer exercise one code path.
//
// Registering a task type REPLACES its set rather than unioning with these, which is a behaviour
// change from the module-global seam and the honest one: a deployment's declaration is its final
// answer, and the previous silent union meant a deployment could not remove a shipped default
// however it wrote the call. A deployment that wants the writing-style set alongside its own
// spreads `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` into its own list, which says so in the code.
// ---------------------------------------------------------------------------

/** The built-in per-task-type defaults shipped with the catalog (today: document only). */
export const BUILTIN_TASK_TYPE_DEFAULTS: Partial<Record<TaskType, readonly string[]>> = {
  document: DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS,
}
