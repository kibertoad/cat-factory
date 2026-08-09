// The LEDGER: what previous specs in this acceptance run already built.
//
// Why a file rather than module state: one full pass costs real model spend and the better part
// of an afternoon, and the specs form a chain (03 files a bug against the feature 02 shipped
// into the repositories 01 bootstrapped). A crash in 03 must not mean re-bootstrapping two
// repositories and re-shipping a feature. So each spec RECORDS what it created and each spec
// starts by asking whether its own output already exists; a re-run against the same
// `ACCEPTANCE_RUN_ID` resumes at the first unfinished step.
//
// It is deliberately a dumb append-of-facts, not a state machine. The authority on what exists
// is the deployment, and every spec re-reads it (the ledger holds ids, never statuses); the
// ledger's only job is to remember which ids to re-read.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** One repository the suite bootstrapped, and the board service frame it materialised. */
export type ServiceRecord = {
  /** The board block id of the service frame (the app API addresses blocks by this). */
  blockId: string
  /** The same frame as `/api/v1` names it. Identical value; both spellings appear in the specs. */
  serviceId: string
  repoName: string
  repoUrl: string | null
}

/** One pipeline run the suite started, keyed by the task that owns it. */
export type RunRecord = {
  taskId: string
  runId: string | null
  pullRequestUrl: string | null
}

export type World = {
  /** Groups everything one pass created; also the repository-name suffix, so passes never collide. */
  runId: string
  backend: ServiceRecord | null
  frontend: ServiceRecord | null
  /**
   * Spec 02, per service. Two records rather than one because the planted mismatch has two halves
   * and spec 02 asserts the ephemeral-environment evidence of EACH: collapsing them would make
   * the second run's report unreadable, which is the one that carries the frontend's environment.
   */
  featureBackend: RunRecord | null
  featureFrontend: RunRecord | null
  /** Spec 03: the bug report filed against the shipped feature. */
  bugfix: RunRecord | null
}

export function emptyWorld(runId: string): World {
  return {
    runId,
    backend: null,
    frontend: null,
    featureBackend: null,
    featureFrontend: null,
    bugfix: null,
  }
}

/**
 * The run id for this pass: `ACCEPTANCE_RUN_ID` when set, else a fresh one.
 *
 * Setting it is how a re-run RESUMES rather than starting a second pass, so the suite prints it
 * on every load: an operator whose spec 03 died needs that value and has no other way to get it.
 */
export function resolveRunId(env: Readonly<Record<string, string | undefined>>): string {
  const pinned = env.ACCEPTANCE_RUN_ID?.trim()
  if (pinned) return pinned
  // Seconds granularity, no separators: it becomes part of a GitHub repository name, where the
  // character set is narrow and the length budget is not generous.
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

export class WorldStore {
  readonly #path: string
  #world: World

  constructor(stateDir: string, runId: string) {
    const dir = isAbsolute(stateDir) ? stateDir : join(packageRoot, stateDir)
    this.#path = join(dir, `${runId}.json`)
    mkdirSync(dir, { recursive: true })
    this.#world = readWorld(this.#path) ?? emptyWorld(runId)
  }

  get path(): string {
    return this.#path
  }

  get value(): World {
    return this.#world
  }

  /**
   * Merge a fact in and persist immediately.
   *
   * Written synchronously and in full on every patch: the process this is protecting against is
   * one that dies mid-run, and a batched or deferred write is precisely the one that loses the id
   * of the pull request nobody can now find.
   */
  patch(patch: Partial<World>): World {
    this.#world = { ...this.#world, ...patch }
    writeFileSync(this.#path, `${JSON.stringify(this.#world, null, 2)}\n`, 'utf8')
    return this.#world
  }

  /** Read a required record, failing with what to re-run rather than a null dereference. */
  require<K extends keyof World>(key: K): NonNullable<World[K]> {
    const value = this.#world[key]
    if (value === null || value === undefined) {
      throw new Error(
        `The ledger has no '${String(key)}' for run ${this.#world.runId}. The spec that records ` +
          `it has not passed yet. Run the suite from the start, or set ACCEPTANCE_RUN_ID to a ` +
          `pass that got further. Ledger: ${this.#path}`,
      )
    }
    return value as NonNullable<World[K]>
  }
}

/**
 * Read a ledger, treating an unreadable or malformed one as ABSENT.
 *
 * A ledger is a cache of ids, so the cost of ignoring a corrupt one is a fresh pass rather than
 * wrong state, and refusing to start because a JSON file has a stray byte would be the worse
 * failure. It is separated out (and exported) so `test/world.test.ts` can pin that choice.
 */
export function readWorld(path: string): World | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // silent-catch-ok: an absent ledger is the normal first-run state, not a condition to report.
    return null
  }
  try {
    return coerceWorld(JSON.parse(raw))
  } catch {
    // silent-catch-ok: a malformed ledger is discarded by design (see the doc comment above).
    return null
  }
}

/** Narrow parsed JSON to a `World`, or null. Total, so a hand-edited ledger cannot crash a spec. */
export function coerceWorld(value: unknown): World | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.runId !== 'string' || record.runId.length === 0) return null
  return {
    runId: record.runId,
    backend: coerceService(record.backend),
    frontend: coerceService(record.frontend),
    featureBackend: coerceRun(record.featureBackend),
    featureFrontend: coerceRun(record.featureFrontend),
    bugfix: coerceRun(record.bugfix),
  }
}

function coerceService(value: unknown): ServiceRecord | null {
  const record = asRecord(value)
  if (!record) return null
  const { blockId, serviceId, repoName } = record
  if (
    typeof blockId !== 'string' ||
    typeof serviceId !== 'string' ||
    typeof repoName !== 'string'
  ) {
    return null
  }
  return {
    blockId,
    serviceId,
    repoName,
    repoUrl: typeof record.repoUrl === 'string' ? record.repoUrl : null,
  }
}

function coerceRun(value: unknown): RunRecord | null {
  const record = asRecord(value)
  if (!record) return null
  if (typeof record.taskId !== 'string') return null
  return {
    taskId: record.taskId,
    runId: typeof record.runId === 'string' ? record.runId : null,
    pullRequestUrl: typeof record.pullRequestUrl === 'string' ? record.pullRequestUrl : null,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}
