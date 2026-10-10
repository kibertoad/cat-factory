import type { CustomTaskType, TaskTypeMeta } from '~/types/domain'

/**
 * Custom task-type projection (frontend-extension-mechanism initiative, slice B — the frontend
 * analogue of `customKindToArchetype` for agent kinds).
 *
 * A deployment's BACKEND-registered task types arrive in the workspace snapshot as
 * `customTaskTypes` (wire data), folded into the shared per-workspace capability manifest (see
 * `./capabilities.ts`). CODE-shipped consumer task types instead enter via the static `taskTypes`
 * slot (a `registerAppModule` module); the task-types store merges both. This module holds only
 * the wire→display projection they share.
 */

/**
 * Project a wire {@link CustomTaskType} onto the frontend's display {@link TaskTypeMeta}. A custom
 * type carries a LITERAL label (from the wire presentation), unlike a built-in type whose label is
 * an i18n key — so the projected meta sets `label` (not `labelKey`); the renderer resolves the
 * display string accordingly (`labelKey ? t(labelKey) : label`).
 */
export function customTaskTypeToMeta(t: CustomTaskType): TaskTypeMeta {
  return {
    taskType: t.taskType,
    icon: t.presentation.icon,
    color: t.presentation.color,
    label: t.presentation.label,
  }
}
