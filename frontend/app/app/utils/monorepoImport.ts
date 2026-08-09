import type { FrameRepoType, FrontendBackendBinding, FrontendConfig } from '~/types/domain'

/**
 * Planning rules for a monorepo import: turning the picked subdirectories into the frames to
 * create, and the `frontendConfig` patches those frames owe once they have ids.
 *
 * The relationship model already exists: a `frontend` frame's `backendBindings` ARE the
 * frontend→service board link (`@cat-factory/contracts`'s `frontendBackendBindingSchema`), the
 * frontend counterpart of a service frame's `serviceConnections`. All this adds is declaring it
 * at IMPORT time, while the user still has the whole selection in front of them, instead of
 * making them open the frontend's inspector afterwards and re-pick services one row at a time.
 *
 * Pure and frontend-only: the modal is the sole caller, so these rules stay here rather than in
 * contracts (nothing on the backend has to agree about them, since it sees ordinary frame creates
 * and ordinary `frontendConfig` patches).
 */

/**
 * Whether the import may offer a frontend mark for the directories it is about to create.
 *
 * Two conditions, both about the mark meaning something:
 *
 * - The picked role is `service`. A backend binding may only point at a `service` frame, so
 *   marking a frontend among libraries or document repos would wire nothing, and when the role
 *   already IS `frontend`, every frame is one and singling one out says nothing.
 * - At least two directories are being CREATED. The mark divides that set into "the frontend" and
 *   "the backends it talks to"; with one there is no rest to bind to, and the role select above
 *   already covers importing a lone frontend. The count is of what the add will actually create,
 *   never of the raw cart: a cart entry whose frame already exists (a retry after a partial
 *   failure) is filtered out of the import, so counting it would offer a mark that binds nothing.
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
  /**
   * Whether this is the ONE directory marked as the frontend for the others, so its config binds
   * every other frame the import creates.
   *
   * Stated here rather than left to be re-derived from `type`, because `type === 'frontend'` does
   * NOT identify it: when the picked ROLE is `frontend`, every entry carries that type and no mark
   * was ever on offer (see {@link canDesignateFrontend}), so a type test picks an arbitrary frame
   * and binds it to a backend set that does not exist.
   */
  designatedFrontend: boolean
}

/**
 * The frames to create for a monorepo import, in the order the user picked them.
 *
 * A `frontendDirectory` is honoured only when the mark would MEAN something, and this is the one
 * place that decides. Two ways it can be stale, both of which designate nothing rather than
 * promoting some other frame:
 *
 * - The role or the size of the import no longer admits a mark ({@link canDesignateFrontend}), so
 *   the picker is not even on screen. Enforced here rather than trusted to the caller, because a
 *   caller that re-derives the condition can drift from it.
 * - The marked directory is not among the ones being created: it was removed from the cart, or an
 *   earlier add already created it.
 */
export function planMonorepoImport(
  directories: readonly string[],
  backendType: FrameRepoType,
  frontendDirectory: string | undefined,
): MonorepoImportEntry[] {
  const marked =
    canDesignateFrontend(backendType, directories.length) && frontendDirectory !== undefined
  const frontend = marked && directories.includes(frontendDirectory) ? frontendDirectory : undefined
  return directories.map((directory) => ({
    directory,
    type: directory === frontend ? 'frontend' : backendType,
    designatedFrontend: directory === frontend,
  }))
}

/** A frame the import created, paired with the plan entry it was created from. */
export interface CreatedMonorepoFrame {
  /** Id of the block the create call minted. */
  blockId: string
  /** The entry that produced it, carrying its role and whether it is the designated frontend. */
  entry: MonorepoImportEntry
}

/** One `frontendConfig` write the import owes a frame it created. */
export interface FrontendConfigPatch {
  blockId: string
  config: FrontendConfig
}

/**
 * The `frontendConfig` each created `frontend` frame needs, once the create calls have minted
 * their ids.
 *
 * EVERY frontend frame gets one, not only a designated one, because the patch carries two
 * separable facts:
 *
 * - **`directory`, for all of them.** A frame's monorepo subdirectory is a SERVICE-level fact (the
 *   repo projection's `directory`, which scopes an agent's checkout); the harness's frontend
 *   install/build/serve reads `frontendConfig.directory` instead, and defaults to the repo root
 *   when it is absent. So a monorepo frontend whose config does not repeat it builds the wrong
 *   tree, silently. That is true of every frontend frame an import creates, including a whole cart
 *   imported under the `frontend` role, where no mark is ever offered. The user picked the
 *   directory, so it is copied, never guessed.
 * - **`backendBindings`, for the designated one only.** The mark is what says "these other frames
 *   are the backends this app talks to"; an undesignated frontend frame is bound to nothing, which
 *   is the same empty list the inspector would have shown.
 */
export function planFrontendConfigPatches(
  created: readonly CreatedMonorepoFrame[],
): FrontendConfigPatch[] {
  const designated = created.find((frame) => frame.entry.designatedFrontend)
  const backendBlockIds = designated
    ? created.filter((frame) => frame !== designated).map((frame) => frame.blockId)
    : []
  return created
    .filter((frame) => frame.entry.type === 'frontend')
    .map((frame) => ({
      blockId: frame.blockId,
      config: frontendConfigForImport(
        frame.entry.directory,
        frame === designated ? backendBlockIds : [],
      ),
    }))
}

/**
 * The `frontendConfig` for one created frontend frame: where the app lives in the repo, and one
 * backend binding per frame it was marked the frontend for.
 *
 * **`envVar` is left EMPTY.** The env var a frontend reads for an upstream URL is a fact about the
 * frontend's own source, which an import that never looks inside the repo cannot know, and
 * inventing a plausible name (`PUB_API_URL`) would inject a variable nothing reads while looking
 * configured. Empty is the contract's designed inert state: the job-body builder filters those
 * bindings out of the injected env, `duplicateBindingEnvVars` ignores them, `frontendOriginsForService`
 * skips them, and the board still draws the frontend→service edge. What the import DOES know (which
 * services this frontend talks to) is recorded; the names are left for the inspector's "Detect from
 * repo" (which reads the repo's dotenv examples) or the user, and the modal says so.
 */
function frontendConfigForImport(
  directory: string,
  backendBlockIds: readonly string[],
): FrontendConfig {
  const backendBindings: FrontendBackendBinding[] = backendBlockIds.map((serviceBlockId) => ({
    envVar: '',
    source: { kind: 'service', serviceBlockId },
  }))
  return { directory, backendBindings }
}
