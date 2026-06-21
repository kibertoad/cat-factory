import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BlueprintJob, BlueprintResult } from './job.js'
import { cloneRepo, commitAll, pushBranch } from './git.js'
import type { PiRunStats } from './pi.js'
import {
  agentNeverActed,
  agentOutputTail,
  NEVER_ACTED_CAUSE,
  runAgentInWorkspace,
  withWorkspace,
} from './pi-workspace.js'
import {
  type StructuredOutputDiagnostics,
  diagnosticsSuffix,
  resolveStructuredOutput,
} from './structured-output.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

/** Compact description of the blueprint-tree shape, fed to the JSON repair call. */
const BLUEPRINT_SHAPE_HINT =
  'Expected a service tree: {"type": string, "name": string, "summary": string, ' +
  '"references": string[], "modules": [{"name": string, "summary": string, ' +
  '"references": string[]}]}.'

// Runs one "service blueprint" job end to end. The Blueprinter agent gets a fresh
// clone of the target branch, (re)decomposes the repository into the canonical
// service → modules tree, and the harness deterministically renders that tree into
// the in-repo `blueprints/` folder (a machine-readable `blueprint.json` plus a
// high-level `overview.md` and one deep-dive markdown per module), then commits the
// result back onto the same branch. The tree is also returned to the Worker so it
// can persist + reconcile the board from it.
//
// Mirrors handleBootstrap's secret handling and watchdog wiring: the per-job
// GitHub + proxy tokens arrive in the request body and live only for the job's
// duration in an ephemeral workspace; `opts` carry the watchdog signal and the
// progress callback so the Worker can poll live "N/M done" subtask counts.

// The folder + file layout, kept in lockstep with @cat-factory/contracts
// (BLUEPRINT_DIR / BLUEPRINT_JSON_PATH / …). Duplicated here because the harness
// image is deliberately self-contained (no @cat-factory/contracts dependency).
const BLUEPRINT_DIR = 'blueprints'
const BLUEPRINT_JSON_PATH = `${BLUEPRINT_DIR}/blueprint.json`
const BLUEPRINT_OVERVIEW_PATH = `${BLUEPRINT_DIR}/overview.md`
const BLUEPRINT_MODULES_DIR = `${BLUEPRINT_DIR}/modules`
/** Tiny manifest read for quick staleness checks without parsing the full tree. */
const BLUEPRINT_VERSION_PATH = `${BLUEPRINT_DIR}/version.json`

// Coercion limits, mirroring core's board-scan.logic so a committed blueprint can
// never balloon past what the board/schema accept.
const MAX_MODULES = 40
const MAX_REFERENCES = 40

const BLOCK_TYPES = [
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
  'environment',
] as const

/** A cohesive area of the service. */
export interface BlueprintModuleTree {
  name: string
  summary: string
  references: string[]
}
/** The repository as a single top-level service with its modules. */
export interface BlueprintServiceTree {
  type: string
  name: string
  summary: string
  references: string[]
  modules: BlueprintModuleTree[]
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function coerceReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const raw of value) {
    const path = asString(raw)
    if (path) seen.add(path)
    if (seen.size >= MAX_REFERENCES) break
  }
  return [...seen]
}

function coerceModule(value: unknown): BlueprintModuleTree | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const name = asString(obj.name)
  if (!name) return null
  return {
    name,
    summary: asString(obj.summary) ?? '',
    references: coerceReferences(obj.references),
  }
}

/**
 * Coerce an agent's parsed JSON into a well-formed {@link BlueprintServiceTree},
 * dropping anything malformed. Returns null when no usable service name remains.
 * Tolerates either a bare service object or `{ service: {...} }`. Mirrors core's
 * `coerceService`; the Worker re-validates the returned tree against the strict
 * Valibot schema before it touches the board.
 */
export function coerceService(parsed: unknown, fallbackName: string): BlueprintServiceTree | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const root = parsed as Record<string, unknown>
  const obj =
    typeof root.service === 'object' && root.service !== null
      ? (root.service as Record<string, unknown>)
      : root
  const name = asString(obj.name) ?? asString(fallbackName)
  if (!name) return null
  const type = (BLOCK_TYPES as readonly string[]).includes(obj.type as string)
    ? (obj.type as string)
    : 'service'
  const modules = (Array.isArray(obj.modules) ? obj.modules : [])
    .map(coerceModule)
    .filter((m): m is BlueprintModuleTree => m !== null)
    .slice(0, MAX_MODULES)
  return {
    type,
    name,
    summary: asString(obj.summary) ?? '',
    references: coerceReferences(obj.references),
    modules,
  }
}

/** A repo-relative file the harness writes (path + UTF-8 content). */
export interface RenderedFile {
  path: string
  content: string
}

/** Turn a module name into a stable, filesystem-safe slug for its deep-dive file. */
export function moduleSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'module'
}

/** The exact canonical JSON bytes written to `blueprint.json` (and hashed). */
export function canonicalBlueprintJson(service: BlueprintServiceTree): string {
  return `${JSON.stringify(service, null, 2)}\n`
}

/** A stable content hash of the blueprint tree, used for quick staleness checks. */
export function hashBlueprint(service: BlueprintServiceTree): string {
  return createHash('sha256').update(canonicalBlueprintJson(service)).digest('hex')
}

/** The lightweight version manifest agents read to check the blueprint is current. */
export interface BlueprintVersion {
  /** Monotonic counter, bumped only when the blueprint content actually changes. */
  version: number
  /** ISO-8601 timestamp of the generation that produced the current content. */
  generatedAt: string
  /** sha256 of the canonical `blueprint.json` — compare to detect drift cheaply. */
  hash: string
  /** Module count, so staleness tooling needn't open the full tree. */
  modules: number
}

/** Render the lightweight `version.json` manifest for `service`. */
export function renderVersionFile(
  service: BlueprintServiceTree,
  meta: { version: number; generatedAt: string },
): RenderedFile {
  const manifest: BlueprintVersion = {
    version: meta.version,
    generatedAt: meta.generatedAt,
    hash: hashBlueprint(service),
    modules: service.modules.length,
  }
  return { path: BLUEPRINT_VERSION_PATH, content: `${JSON.stringify(manifest, null, 2)}\n` }
}

function renderReferences(references: string[]): string[] {
  if (references.length === 0) return []
  return ['', '**Code references:**', ...references.map((r) => `- \`${r}\``)]
}

/**
 * Deterministically render a blueprint tree into the in-repo artifact files: the
 * canonical `blueprint.json`, a high-level `overview.md` (service + each module
 * with a one-line summary — what agents read first), and one `modules/<slug>.md`
 * deep-dive per module (summary + code references — read only when a task touches
 * that module). Pure: same tree → same bytes.
 */
export function renderBlueprintFiles(service: BlueprintServiceTree): RenderedFile[] {
  const files: RenderedFile[] = []

  // Canonical machine-readable tree (trailing newline for clean diffs).
  files.push({ path: BLUEPRINT_JSON_PATH, content: canonicalBlueprintJson(service) })

  // High-level overview — the default read.
  const overview: string[] = [`# ${service.name}`, '']
  overview.push('> Generated service blueprint. Read this overview first for the')
  overview.push('> high-level structure; open `modules/<name>.md` only for a module')
  overview.push('> directly relevant to your task.')
  overview.push('')
  if (service.summary) overview.push(service.summary, '')
  if (service.modules.length === 0) {
    overview.push('_No modules mapped yet._')
  } else {
    overview.push('## Modules', '')
    for (const m of service.modules) {
      const slug = moduleSlug(m.name)
      overview.push(`### [${m.name}](modules/${slug}.md)`)
      if (m.summary) overview.push('', m.summary)
      overview.push('')
    }
  }
  files.push({ path: BLUEPRINT_OVERVIEW_PATH, content: `${overview.join('\n').trimEnd()}\n` })

  // Per-module deep dives — the drill-down layer.
  for (const m of service.modules) {
    const slug = moduleSlug(m.name)
    const lines: string[] = [`# ${m.name}`, '']
    if (m.summary) lines.push(m.summary, '')
    lines.push(...renderReferences(m.references))
    files.push({
      path: `${BLUEPRINT_MODULES_DIR}/${slug}.md`,
      content: `${lines.join('\n').trimEnd()}\n`,
    })
  }

  return files
}

/** Read + parse the existing canonical blueprint, if any (for an `update` run). */
async function readExistingBlueprint(
  dir: string,
  fallbackName: string,
): Promise<BlueprintServiceTree | null> {
  try {
    const raw = await readFile(join(dir, BLUEPRINT_JSON_PATH), 'utf8')
    // A hand-edited file that no longer parses is treated as absent (regenerate),
    // mirroring the strict re-validation the Worker applies on ingest.
    return coerceService(JSON.parse(raw), fallbackName)
  } catch {
    return null
  }
}

/** Read the prior version manifest, if any (to bump the counter / detect no-ops). */
async function readExistingVersion(dir: string): Promise<BlueprintVersion | null> {
  try {
    const raw = await readFile(join(dir, BLUEPRINT_VERSION_PATH), 'utf8')
    const parsed = JSON.parse(raw) as Partial<BlueprintVersion>
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
 * Decide the version manifest for a freshly generated tree: when the content is
 * byte-identical to the previous generation, the version + timestamp are kept (so
 * an unchanged blueprint produces no diff and no commit); otherwise the counter is
 * bumped and the timestamp refreshed.
 */
export function nextVersion(
  service: BlueprintServiceTree,
  previous: BlueprintVersion | null,
  now: Date,
): { version: number; generatedAt: string } {
  if (previous && previous.hash === hashBlueprint(service)) {
    return { version: previous.version, generatedAt: previous.generatedAt }
  }
  return { version: (previous?.version ?? 0) + 1, generatedAt: now.toISOString() }
}

/** Extract the first JSON object from an agent's final message (tolerating fences/prose). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  // Strip a single ```json … ``` (or ``` … ```) fence if the whole reply is fenced.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fenced ? (fenced[1] ?? '') : trimmed
  try {
    return JSON.parse(body)
  } catch {
    // Fall back to the first balanced { … } span in the text.
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('agent did not return a JSON object')
    }
    return JSON.parse(body.slice(start, end + 1))
  }
}

/** Compose the task prompt: the worker's guidance plus any prior tree to refine. */
function buildUserPrompt(job: BlueprintJob, existing: BlueprintServiceTree | null): string {
  const lines = [job.instructions.trim()]
  if (job.mode === 'update' && existing) {
    lines.push(
      '',
      'An existing blueprint is present. Update it to reflect the current code:',
      'keep accurate modules, add new ones, refine summaries and code',
      'references. Return the COMPLETE updated tree (not a diff).',
      '',
      'Existing blueprint:',
      '```json',
      JSON.stringify(existing, null, 2),
      '```',
    )
  }
  lines.push(
    '',
    'Respond with ONLY the JSON object for the service tree — no prose, no code fences.',
  )
  return lines.join('\n')
}

/** Write the rendered files under `dir`, replacing any previous `blueprints/` folder. */
async function writeBlueprintFiles(dir: string, files: RenderedFile[]): Promise<void> {
  // The whole folder is a generated artifact: wipe it first so a module removed
  // from the tree doesn't leave a stale deep-dive file behind.
  await rm(join(dir, BLUEPRINT_DIR), { recursive: true, force: true })
  for (const file of files) {
    const abs = join(dir, file.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, file.content, 'utf8')
  }
}

/** Run one blueprint job end to end. */
export async function handleBlueprint(
  job: BlueprintJob,
  opts: RunOptions = {},
): Promise<BlueprintResult> {
  const { signal } = opts
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  return withWorkspace('blueprint', async (dir) => {
    log.info('blueprint: cloning target branch', trace)
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      signal,
    })

    const existing = job.mode === 'update' ? await readExistingBlueprint(dir, job.repo.name) : null
    // The prior version manifest is read regardless of mode so the counter keeps
    // climbing across runs (and an unchanged tree stays at the same version).
    const previousVersion = await readExistingVersion(dir)

    log.info('blueprint: running agent', { ...trace, mode: job.mode })
    const { summary, stats, stderrTail, usage } = await runAgentInWorkspace(
      {
        dir,
        systemPrompt: job.systemPrompt,
        userPrompt: buildUserPrompt(job, existing),
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        // The Blueprinter explores the repo and RETURNS the service tree as JSON —
        // the harness renders + commits the `blueprints/` files (below), the agent
        // itself never calls an edit/write tool. So the no-edit guard must be off
        // (like the merger), or mapping a non-trivial repo would trip it after many
        // read calls and kill the run before it could emit the tree.
        expectsEdits: false,
      },
      opts,
    )

    // Parse the agent's tree; on a malformed reply, make ONE structured repair call
    // (see json-repair) before giving up. The failure + repair outcome are logged and
    // folded into the failure reason for observability.
    const { value: service, diagnostics } = await resolveStructuredOutput(
      {
        label: 'blueprint',
        shapeHint: BLUEPRINT_SHAPE_HINT,
        parse: (text) => coerceService(extractJsonObject(text), job.repo.name),
      },
      summary,
      {
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        model: job.model,
        jobId: job.jobId,
        signal,
      },
    )
    if (!service) {
      return {
        summary,
        stats,
        error: noBlueprintReason(stats, summary, stderrTail, diagnostics),
        ...(usage ? { usage } : {}),
      }
    }

    const version = nextVersion(service, previousVersion, new Date())
    await writeBlueprintFiles(dir, [
      ...renderBlueprintFiles(service),
      renderVersionFile(service, version),
    ])

    // Add one commit onto the branch (no history reset, no force). An unchanged
    // blueprint produces no commit — we still return the tree so the board ingest
    // is idempotent.
    const message = job.mode === 'update' ? 'Update service blueprint' : 'Add service blueprint'
    const committed = await commitAll(dir, message, signal)
    if (committed) {
      log.info('blueprint: pushing regenerated blueprint', { ...trace, ...stats })
      await pushBranch(dir, job.branch, job.ghToken, signal)
    } else {
      log.info('blueprint: no changes to push (blueprint unchanged)', trace)
    }

    return { service, summary, stats, ...(usage ? { usage } : {}) }
  })
}

/** Human-readable reason a blueprint run produced no usable tree. */
function noBlueprintReason(
  stats: PiRunStats,
  summary: string,
  stderrTail: string | undefined,
  diagnostics?: StructuredOutputDiagnostics,
): string {
  const cause = agentNeverActed(stats) ? NEVER_ACTED_CAUSE : ''
  return (
    `the blueprint agent produced no usable decomposition ` +
    `(tool calls: ${stats.toolCalls}, assistant output: ${stats.assistantChars} chars).${cause}` +
    (diagnostics ? diagnosticsSuffix(diagnostics) : '') +
    agentOutputTail(stderrTail, summary)
  )
}
