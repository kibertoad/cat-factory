import type { CustomTaskType } from '@cat-factory/contracts'

// App-owned registry of CUSTOM (deployment-registered) task types, mirroring the
// agent-kind / gate / pipeline registries. A deployment — e.g. a proprietary org package —
// registers its task types on the instance the composition root injects
// (`registry.register(taskType)`); the server serialises them into the workspace snapshot
// (`customTaskTypes`) so the SPA renders each as a first-class create-task choice + card
// badge, and `defaultPipelineIdForTaskType` consults the registry after the built-in map so
// a custom type can pin its own default pipeline.
//
// Engine-level, not persistence — a custom-typed task is just a `taskType` string on the
// block (the widened `taskTypeSchema`), so there is no per-runtime storage work: both facades
// build the SAME empty registry (`defaultTaskTypeRegistry()`) and register the same
// deployment types by reference. `defaultTaskTypeRegistry()` is EMPTY (there are no built-in
// custom task types — the built-ins are the closed `BUILTIN_TASK_TYPES` picklist).

/**
 * App-owned registry of custom task types. The composition root news ONE instance and a
 * deployment registers its task types on it by reference; the snapshot projection + the
 * default-pipeline resolution read it back.
 */
export class TaskTypeRegistry {
  private readonly registry = new Map<string, CustomTaskType>()

  /** Register a custom task type. A registration whose id matches an earlier one replaces it. */
  register(taskType: CustomTaskType): void {
    this.registry.set(taskType.taskType, taskType)
  }

  /** Register several custom task types at once. */
  registerAll(taskTypes: Iterable<CustomTaskType>): void {
    for (const taskType of taskTypes) this.register(taskType)
  }

  /** The registered custom task type for `taskType`, or undefined. */
  get(taskType: string): CustomTaskType | undefined {
    return this.registry.get(taskType)
  }

  /** All registered custom task types (registration order). */
  all(): CustomTaskType[] {
    return [...this.registry.values()]
  }

  /** The default pipeline id a registered task type prefers, if any (else undefined). */
  defaultPipelineId(taskType: string): string | undefined {
    return this.registry.get(taskType)?.defaultPipelineId
  }
}

/** A fresh, EMPTY task-type registry. Each facade news one and a deployment registers on it. */
export function defaultTaskTypeRegistry(): TaskTypeRegistry {
  return new TaskTypeRegistry()
}
