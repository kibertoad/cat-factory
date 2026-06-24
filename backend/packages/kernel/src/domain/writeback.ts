import type { WritebackOverride } from './types.js'

// Pure resolution of an issue-tracker writeback action's effective state from the
// workspace default and the optional per-task override. The override (when set)
// always wins; absent ⇒ inherit the workspace setting. Kept here (pure, no I/O) so
// both the engine and the UI can resolve the same way and it is unit-testable.

export function resolveWritebackFlag(
  workspaceEnabled: boolean,
  override: WritebackOverride | null | undefined,
): boolean {
  if (override === 'on') return true
  if (override === 'off') return false
  return workspaceEnabled
}
