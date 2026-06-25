import {
  BLUEPRINT_DIR,
  BLUEPRINT_VERSION_PATH,
  type BlueprintVersion,
  SPEC_DIR,
  SPEC_FEATURES_DIR,
  SPEC_MODULES_DIR,
} from '@cat-factory/contracts'
import type { RepoFiles, RepoOp } from '@cat-factory/kernel'
import {
  coerceBlueprintService,
  coerceSpecDoc,
  hashBlueprint,
  nextBlueprintVersion,
  type RenderedFile,
  renderBlueprintFiles,
  renderBlueprintVersionFile,
  renderSpecFeatureFiles,
  renderSpecFiles,
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

// ---------------------------------------------------------------------------
// BUILT-IN post-op: spec-writer — the deterministic SHARD + commit of the in-repo `spec/`
// artifact a migrated `spec-writer` explore agent produces (formerly the executor-harness
// `/spec` handler's `writeRequirementsFiles`). The container's read-only explore agent reads
// the baseline spec from its own checkout and returns the COMPLETE updated tree as JSON;
// `toRunResult` coerces it into `result.spec`; this post-op renders + reconciles it onto the
// run's work branch over the checkout-free {@link RepoFiles}.
// ---------------------------------------------------------------------------

/** Pre-sharding monolithic spec files; never written any more, deleted on sight (no-compat). */
const LEGACY_SPEC_FILES = [
  `${SPEC_DIR}/spec.json`,
  `${SPEC_DIR}/rules.md`,
  `${SPEC_DIR}/version.json`,
]

/**
 * Every canonical shard file currently under `spec/modules/`, repo-relative — the
 * `.json`/`.md` files the renderer OWNS (so a removed module/group is an orphan to prune).
 * The folder is two levels deep (`modules/<m>/{_module.json,<g>.json,<g>.md}`), so one
 * recursion into each module directory is enough.
 */
async function listSpecModuleFiles(repo: RepoFiles, branch: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await repo.listDirectory(SPEC_MODULES_DIR, branch)) {
    if (entry.type !== 'dir') continue
    for (const sub of await repo.listDirectory(entry.path, branch)) {
      if (sub.type !== 'dir' && (sub.path.endsWith('.json') || sub.path.endsWith('.md'))) {
        out.push(sub.path)
      }
    }
  }
  return out
}

/**
 * Old FLAT-layout Gherkin files directly under `spec/features/` (before features were
 * nested under `features/<module>/`). The sharded renderer never targets a top-level
 * `.feature`, so any such file is a stale orphan — prune it. Nested `<module>/<g>.feature`
 * files live in subdirectories and are NOT touched (they are seed-once, see below).
 */
async function listLegacyFeatureFiles(repo: RepoFiles, branch: string): Promise<string[]> {
  return (await repo.listDirectory(SPEC_FEATURES_DIR, branch))
    .filter((e) => e.type !== 'dir' && e.path.endsWith('.feature'))
    .map((e) => e.path)
}

/**
 * POST-OP for the migrated `spec-writer` kind: SHARD the agent's spec doc into the in-repo
 * `spec/` artifact and commit it onto the run's work branch — the deterministic work the
 * harness's `handleSpec`/`writeRequirementsFiles` used to do, now plain backend TS over the
 * checkout-free {@link RepoFiles}.
 *
 * Reconciliation mirrors the harness exactly:
 *  - The CANONICAL shards (`service.json`, `overview.md`, the per-group `modules/<m>/<g>.{json,md}`
 *    + `_module.json`) are always rewritten; a module/group the new doc no longer contains is an
 *    ORPHAN that is DELETED (else the next reassembly would resurrect it).
 *  - The Gherkin `features/<m>/<g>.feature` files are SEED-ONCE: committed only when ABSENT,
 *    never overwritten (so a later manual / pass-2 acceptance polish survives a re-run).
 *  - The pre-sharding monolithic artifacts (`spec.json`/`rules.md`/`version.json`) and the old
 *    FLAT `features/*.feature` files are deleted on sight.
 *
 * IDEMPOTENT (spec has no `version.json` manifest, so we byte-compare): an unchanged tree —
 * a re-run, or a durable-driver REPLAY re-entering after the commit landed — renders shards
 * whose bytes match the branch, seeds no new feature file, and prunes nothing ⇒ no commit,
 * exactly as the harness's `commitAll` found nothing staged.
 */
export const specPostOp: RepoOp = async (ctx) => {
  // The engine coerced the agent's structured output into `spec`; re-coerce to a typed doc
  // (idempotent on an already-coerced doc) so a nameless/garbage payload commits nothing.
  // The doc must carry its own `service` name (no repo-name rescue — see `toRunResult`); an
  // already-coerced doc that reaches here always has one, so the empty fallback never bites.
  const doc = coerceSpecDoc(ctx.result?.spec, '')
  if (!doc) return

  const canonical = renderSpecFiles(doc)
  const features = renderSpecFeatureFiles(doc)

  // SEED-ONCE: only commit a feature file that is absent on the branch (never clobber polish).
  const seededFeatures: RenderedFile[] = []
  for (const f of features) {
    if (!(await ctx.repo.getFile(f.path, ctx.branch))) seededFeatures.push(f)
  }

  // ORPHAN-PRUNE removed canonical shards + drop the legacy monolithic / flat-feature files.
  // Only EXISTING legacy paths are listed for deletion — including an absent one would force a
  // commit on every run (deletions.length > 0) and break the idempotency short-circuit below.
  const desired = new Set(canonical.map((f) => f.path))
  const orphans = (await listSpecModuleFiles(ctx.repo, ctx.branch)).filter((p) => !desired.has(p))
  const presentLegacyMonolith: string[] = []
  for (const p of LEGACY_SPEC_FILES) {
    if (await ctx.repo.getFile(p, ctx.branch)) presentLegacyMonolith.push(p)
  }
  const deletions = [
    ...orphans,
    ...presentLegacyMonolith,
    ...(await listLegacyFeatureFiles(ctx.repo, ctx.branch)),
  ]

  // IDEMPOTENCY: skip the commit when every canonical shard's bytes already match the branch
  // AND there is nothing to seed or delete (replay-safe).
  let changed = false
  for (const f of canonical) {
    const existing = await ctx.repo.getFile(f.path, ctx.branch)
    if (!existing || existing.content !== f.content) {
      changed = true
      break
    }
  }
  if (!changed && seededFeatures.length === 0 && deletions.length === 0) return

  await ctx.repo.commitFiles({
    branch: ctx.branch,
    message: 'Update service requirements',
    files: [...canonical, ...seededFeatures],
    ...(deletions.length > 0 ? { deletions } : {}),
  })
}
