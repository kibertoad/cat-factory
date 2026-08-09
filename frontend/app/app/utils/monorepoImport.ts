import type { FrameRepoType, FrontendBackendBinding, FrontendConfig } from '~/types/domain'

/**
 * Planning rules for a monorepo import: turning the picked subdirectories into the frames to
 * create, and wiring the one the user marked as the FRONTEND to the backends beside it.
 *
 * The relationship model already exists: a `frontend` frame's `backendBindings` ARE the
 * frontend→service board link (`@cat-factory/contracts`'s `frontendBackendBindingSchema`), the
 * frontend counterpart of a service frame's `serviceConnections`. All this adds is declaring it
 * at IMPORT time, while the user still has the whole selection in front of them, instead of
 * making them open the frontend's inspector afterwards and re-pick services one row at a time.
 *
 * Pure and frontend-only: the modal is the sole caller, so these rules stay here rather than in
 * contracts (nothing on the backend has to agree about them, since it sees ordinary frame creates
 * one ordinary `frontendConfig` patch).
 */

/**
 * Whether the import may offer a frontend mark for the current selection.
 *
 * Two conditions, both about the mark meaning something:
 *
 * - The picked role is `service`. A backend binding may only point at a `service` frame, so
 *   marking a frontend among libraries or document repos would wire nothing, and when the role
 *   already IS `frontend`, every frame is one and singling one out says nothing.
 * - At least two directories are picked. The mark divides a selection into "the frontend" and
 *   "the backends it talks to"; with one directory there is no rest to bind to, and the role
 *   select above already covers importing a lone frontend.
 */
export function canDesignateFrontend(type: FrameRepoType, directoryCount: number): boolean {
  return type === 'service' && directoryCount >= 2
}

/** One frame the import will create: its repo subdirectory and the role it takes. */
export interface MonorepoImportEntry {
  /** Repo-root-relative subdirectory the frame is pinned to. */
  directory: string
  /** The frame's repo role: `frontend` for the marked directory, the picked role for the rest. */
  type: FrameRepoType
}

/**
 * The frames to create for a monorepo import, in the order the user picked them.
 *
 * `frontendDirectory` is honoured only when it is actually among the directories being created:
 * a mark left behind by a directory that has since been removed from the cart (or was already on
 * the board) designates nothing, and silently creating some OTHER frame as the frontend would be
 * worse than creating none.
 */
export function planMonorepoImport(
  directories: readonly string[],
  backendType: FrameRepoType,
  frontendDirectory: string | undefined,
): MonorepoImportEntry[] {
  const frontend =
    frontendDirectory && directories.includes(frontendDirectory) ? frontendDirectory : undefined
  return directories.map((directory) => ({
    directory,
    type: directory === frontend ? 'frontend' : backendType,
  }))
}

/**
 * The `frontendConfig` for the frame created from the marked directory: where the app lives in
 * the repo, and one backend binding per service frame created alongside it.
 *
 * Two deliberate choices:
 *
 * - **`directory` is set.** A frame's monorepo subdirectory is a SERVICE-level fact (the repo
 *   projection's `directory`, which scopes an agent's checkout); the harness's frontend
 *   install/build/serve reads `frontendConfig.directory` instead, and defaults to the repo root
 *   when it is absent. So a monorepo frontend whose config does not repeat it builds the wrong
 *   tree. The user picked the directory, so this is copied, never guessed.
 *
 * - **`envVar` is left EMPTY.** The env var a frontend reads for an upstream URL is a fact about
 *   the frontend's own source, which an import that never looks inside the repo cannot know, and
 *   inventing a plausible name (`PUB_API_URL`) would inject a variable nothing reads while
 *   looking configured. Empty is the contract's designed inert state: the job-body builder filters
 *   those bindings out of the injected env, `duplicateBindingEnvVars` ignores them, and the board
 *   still draws the frontend→service edge. What the import DOES know (which services this
 *   frontend talks to) is recorded; the names are left for the inspector's "Detect from repo"
 *   (which reads the repo's dotenv examples) or the user, and the modal says so.
 */
export function frontendConfigForImport(
  directory: string,
  backendBlockIds: readonly string[],
): FrontendConfig {
  const backendBindings: FrontendBackendBinding[] = backendBlockIds.map((serviceBlockId) => ({
    envVar: '',
    source: { kind: 'service', serviceBlockId },
  }))
  return { directory, backendBindings }
}
