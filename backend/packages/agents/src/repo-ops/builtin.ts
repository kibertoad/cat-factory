import {
  BLUEPRINT_DIR,
  BLUEPRINT_VERSION_PATH,
  type BlueprintVersion,
} from '@cat-factory/contracts'
import type { RepoFiles, RepoOp } from '@cat-factory/kernel'
import {
  coerceBlueprintService,
  hashBlueprint,
  nextBlueprintVersion,
  renderBlueprintFiles,
  renderBlueprintVersionFile,
} from './render.js'

// ---------------------------------------------------------------------------
// BUILT-IN post-ops: the deterministic render + commit of the in-repo `blueprints/`
// (and, later, `spec/`) artifacts a migrated built-in agent produces.
//
// These mirror the registry-driven post-ops a CUSTOM kind ships (example-custom-agent's
// `renderReportPostOp`), but they are NOT registry entries: registering the built-in
// kinds would leak them into `customAgentKinds` / the SPA palette. The engine keys them
// off the agent kind in its own built-in map (see ExecutionService) and runs them over
// the same checkout-free {@link RepoFiles} port. The container's generic `agent` explore
// step returns the model's JSON (surfaced as `result.blueprintService`); the mechanical
// render that used to live in the executor-harness `blueprint.ts` runs here as plain
// backend TypeScript — no per-kind container code, no image rebuild.
// ---------------------------------------------------------------------------

/** Parse an existing `version.json` (tolerant — a malformed/absent manifest ⇒ null). */
function parseBlueprintVersion(content: string | undefined): BlueprintVersion | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as Partial<BlueprintVersion>
    if (typeof parsed.version !== 'number' || typeof parsed.hash !== 'string') return null
    return {
      version: parsed.version,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      hash: parsed.hash,
      modules: typeof parsed.modules === 'number' ? parsed.modules : 0,
    }
  } catch {
    return null
  }
}

/**
 * List every file currently under `blueprints/`, repo-relative. The folder is two levels
 * deep at most (`blueprints/*` plus `blueprints/modules/<slug>.md`), so one recursion into
 * any subdirectory is enough; descended via {@link RepoFiles.listDirectory}.
 */
async function listBlueprintFiles(repo: RepoFiles, branch: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await repo.listDirectory(BLUEPRINT_DIR, branch)) {
    if (entry.type === 'dir') {
      for (const sub of await repo.listDirectory(entry.path, branch)) {
        if (sub.type !== 'dir') out.push(sub.path)
      }
    } else {
      out.push(entry.path)
    }
  }
  return out
}

/**
 * POST-OP for the migrated `blueprints` kind: render the agent's service → modules tree
 * into the in-repo `blueprints/` artifact files and commit them onto the run's branch —
 * the deterministic work the harness's `handleBlueprint` used to do, now plain backend TS
 * over the checkout-free {@link RepoFiles}.
 *
 * IDEMPOTENT: the content hash lives in the committed `version.json`. An unchanged tree
 * (a re-run, or a durable-driver REPLAY that re-enters after the commit landed but before
 * the run persisted) hashes identically ⇒ no commit, exactly as the harness's `commitAll`
 * found nothing staged. On a real change it bumps the version, writes the files, and
 * PRUNES any file the new render didn't emit (a removed module's deep-dive) — the
 * checkout-free analogue of the harness wiping `blueprints/` before writing.
 */
export const blueprintPostOp: RepoOp = async (ctx) => {
  // The engine coerced the agent's structured output into `blueprintService` (or the
  // FakeAgentExecutor returned a tree directly). Re-coerce to a typed tree — idempotent on
  // an already-coerced tree — so a nameless/garbage payload commits nothing.
  const service = coerceBlueprintService(ctx.result?.blueprintService, '')
  if (!service) return

  const previous = parseBlueprintVersion(
    (await ctx.repo.getFile(BLUEPRINT_VERSION_PATH, ctx.branch))?.content,
  )
  if (previous && previous.hash === (await hashBlueprint(service))) return

  const version = await nextBlueprintVersion(service, previous, new Date())
  const rendered = [
    ...renderBlueprintFiles(service),
    await renderBlueprintVersionFile(service, version),
  ]
  const desired = new Set(rendered.map((f) => f.path))
  const deletions = (await listBlueprintFiles(ctx.repo, ctx.branch)).filter((p) => !desired.has(p))
  await ctx.repo.commitFiles({
    branch: ctx.branch,
    message: 'Update service blueprint',
    files: rendered,
    ...(deletions.length > 0 ? { deletions } : {}),
  })
}
