import {
  BLUEPRINT_DIR,
  BLUEPRINT_VERSION_PATH,
  type BlueprintVersion,
  SPEC_DIR,
  SPEC_FEATURES_DIR,
  SPEC_MODULES_DIR,
} from '@cat-factory/contracts'
import type { AgentRunResult, RepoFiles, RepoOp } from '@cat-factory/kernel'
import {
  asString,
  clearAspirationalTag,
  coerceBlueprintService,
  coerceSpecDoc,
  hashBlueprint,
  nextBlueprintVersion,
  promoteRequirementStates,
  type RenderedFile,
  renderBlueprintFiles,
  renderBlueprintVersionFile,
  renderSpecFeatureFiles,
  renderSpecFiles,
} from './render.js'
import { readServiceSpec } from './readServiceSpec.js'

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
  // A purely TECHNICAL task produces NO business specs: the writer signalled
  // `noBusinessSpecs`, leaving the baseline spec as-is. Commit nothing (and skip the
  // expensive read/render) — "no new specs" is a valid, intended outcome.
  if (ctx.result?.noBusinessSpecs) return
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

// ---------------------------------------------------------------------------
// BUILT-IN post-op: tester-driven PROMOTION of the in-repo spec's implementation state.
//
// `spec/` is prescriptive — it says what must be TRUE — and `requirementItem.state` is what
// lets it also say what is true YET. A newly written requirement is `aspirational`; a first
// OBSERVED pass promotes it to `established`, which is what makes it standing behaviour for
// every later build and test prompt.
//
// SEAM CHOICE — this post-op, NOT the spec-writer's own update pass. The spec-writer runs
// near the front of every pipeline (0–1 steps behind the requirements gate) while the tester
// runs near the back, so by the time verdicts exist this run's writer has long finished:
// routing promotion through it would defer every promotion to the NEXT run (which may never
// come) and would hand a deterministic, evidence-backed state change to a model that cannot
// see the evidence. Promotion is mechanical, so it belongs in deterministic backend TS over
// the checkout-free RepoFiles port — the same shape `specPostOp` already uses.
//
// IDEMPOTENT BY CONTENT, which is the exact answer the durable driver needs: it re-reads the
// spec from the branch, recomputes the promoted tree and byte-compares. A REPLAY (or a re-test
// after a fixer round) reads an already-promoted spec, produces identical bytes and commits
// nothing. No marker row, no wall-clock guess.
// ---------------------------------------------------------------------------

/** The met requirement ids in a tester's structured report, or an empty set. */
function metRequirementIds(result: AgentRunResult | undefined): Set<string> {
  const report = result?.testReport
  if (!report || typeof report !== 'object') return new Set()
  const verdicts = (report as { requirementVerdicts?: unknown }).requirementVerdicts
  if (!Array.isArray(verdicts)) return new Set()
  const ids = new Set<string>()
  for (const raw of verdicts) {
    if (!raw || typeof raw !== 'object') continue
    const v = raw as { requirementId?: unknown; status?: unknown }
    // ONLY `met` promotes. `not_covered` means nobody looked, and `not_met` means it does not
    // hold — neither is evidence that the service honours the behaviour.
    if (v.status !== 'met') continue
    const id = asString(v.requirementId)
    if (id) ids.add(id)
  }
  return ids
}

/**
 * Whether a canonical path is a per-group JSON shard — `spec/modules/<module>/<group>.json`,
 * the ONLY canonical file that stores requirements and rules. `_module.json` is the module's
 * own identity, and `service.json` / `overview.md` are indexes.
 */
function isGroupShard(path: string): boolean {
  if (!path.startsWith(`${SPEC_MODULES_DIR}/`) || !path.endsWith('.json')) return false
  const rest = path.slice(SPEC_MODULES_DIR.length + 1).split('/')
  return rest.length === 2 && rest[1] !== '_module.json'
}

/** The requirement ids a RENDERED group shard carries (we produced it, so it always parses). */
function requirementIdsIn(content: string): string[] {
  const parsed = JSON.parse(content) as { requirements?: { id?: unknown }[] }
  return (parsed.requirements ?? [])
    .map((r) => asString(r?.id))
    .filter((id): id is string => id !== undefined)
}

/**
 * The group shard whose data governs whether `path` may be rewritten: the shard itself, or —
 * for the human-readable `spec/modules/<module>/<group>.md` render — the shard it is derived
 * from. Null for files that carry no requirement data of their own.
 */
function governingGroupShard(path: string): string | null {
  if (isGroupShard(path)) return path
  if (path.startsWith(`${SPEC_MODULES_DIR}/`) && path.endsWith('.md')) {
    const shard = `${path.slice(0, -'.md'.length)}.json`
    return isGroupShard(shard) ? shard : null
  }
  return null
}

/**
 * POST-OP for the tester kinds: promote every spec requirement the Tester OBSERVED to pass
 * from `aspirational` to `established`, and commit the updated shards onto the run's branch.
 *
 * Reads the spec back from the branch (the tester's own result carries no spec), re-renders
 * only the canonical shards, and surgically drops the now-stale `@aspirational` tag from the
 * seed-once Gherkin files — never re-rendering those, so a pass-2 acceptance polish survives.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION. `readServiceSpec` is deliberately SALVAGING: a requirement
 * or rule that fails validation (one field past a cap the lenient writer never enforced) is
 * dropped so the rest of the tree survives the read. Re-rendering from that view would commit
 * the drop — a state flip on one requirement silently deleting an unrelated one. So every
 * GROUP SHARD is diffed against a BASELINE render taken BEFORE promotion: a shard whose
 * committed bytes don't match its own baseline did not round-trip losslessly, so neither it,
 * nor the markdown derived from it, nor the `@aspirational` tag of a requirement inside it is
 * touched. A path the render would CREATE (a shifted collision suffix) is skipped rather than
 * added beside the original — promotion never restructures the tree, it only flips a field.
 *
 * BEST-EFFORT: a throwing post-op fails its step, and promotion is bookkeeping — a spec that
 * failed to promote must never turn a green tester run red. Every failure path is a silent
 * no-op, exactly like the PR verification report's publish.
 */
export const specPromotionPostOp: RepoOp = async (ctx) => {
  try {
    const met = metRequirementIds(ctx.result)
    if (met.size === 0) return

    const view = await readServiceSpec(ctx.repo, ctx.branch)
    if (!view.present || !view.spec) return

    // Materialised BEFORE the in-place promotion below, so it captures the tree exactly as the
    // read reconstructed it. A committed group shard that differs from this lost something on
    // the way in, and must not be rewritten from it.
    const baseline = new Map(renderSpecFiles(view.spec).map((f) => [f.path, f.content]))

    const promoted = promoteRequirementStates(view.spec, met)
    if (promoted.length === 0) return

    // Re-render the canonical shards only. The seed-once feature files are NOT re-rendered
    // (that would discard pass-2 polish); their stale tag is edited in place below.
    const canonical = renderSpecFiles(view.spec)
    const committed = new Map<string, string | null>()
    for (const f of canonical) {
      const existing = await ctx.repo.getFile(f.path, ctx.branch)
      committed.set(f.path, existing?.content ?? null)
    }

    // A group shard is SAFE when its committed bytes are either the pre-promotion baseline
    // (it round-tripped losslessly) or the post-promotion render (a replay). Anything else
    // means the read dropped or rewrote something, and neither that shard nor the markdown
    // derived from it may be rewritten from the view.
    const safeShards = new Set<string>()
    for (const f of canonical) {
      if (!isGroupShard(f.path)) continue
      const existing = committed.get(f.path)
      if (existing == null) continue
      if (existing === baseline.get(f.path) || existing === f.content) safeShards.add(f.path)
    }

    // The ids whose state change will actually LAND: those living in a safe shard. A
    // requirement stranded in an unsafe one keeps both its `aspirational` shard entry and its
    // `@aspirational` tag, so the two never disagree — clearing the tag alone would make a
    // runner exercise a scenario the spec still calls unbuilt, the unsafe direction of the
    // "a stale tag only ever costs a skip" trade.
    const promotedSet = new Set(promoted)
    const landed = new Set<string>()
    for (const f of canonical) {
      if (!isGroupShard(f.path) || !safeShards.has(f.path)) continue
      for (const id of requirementIdsIn(f.content)) if (promotedSet.has(id)) landed.add(id)
    }
    if (landed.size === 0) return

    const files: RenderedFile[] = []
    for (const f of canonical) {
      const existing = committed.get(f.path) ?? null
      // Absent ⇒ a path this render would CREATE; equal ⇒ already current (a replay).
      if (existing === null || existing === f.content) continue
      // Every other canonical file (`service.json`, `_module.json`, `overview.md`) is a pure
      // index over data that lives in the shards, so rewriting it can lose nothing.
      const shard = governingGroupShard(f.path)
      if (shard && !safeShards.has(shard)) continue
      files.push(f)
    }

    // The feature files were already fetched by `readServiceSpec` — edit the content in hand
    // rather than re-reading each one off the branch.
    for (const feature of view.features) {
      const updated = clearAspirationalTag(feature.content, landed)
      if (updated !== feature.content) files.push({ path: feature.path, content: updated })
    }

    // Nothing actually differs ⇒ a replay. Commit nothing.
    if (files.length === 0) return

    await ctx.repo.commitFiles({
      branch: ctx.branch,
      message: `Promote ${landed.size} verified requirement${
        landed.size === 1 ? '' : 's'
      } to established`,
      files,
    })
  } catch {
    // Bookkeeping: never fail a tester step because the spec could not be promoted.
  }
}
