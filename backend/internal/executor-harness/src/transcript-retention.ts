import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Logger } from './logger.js'

// Session-transcript retention for the subscription harnesses (Claude Code / Codex).
//
// Both runners create an ISOLATED, per-run config home so the leased OAuth credential never
// lands in the cloned checkout, then delete that home in `finally`. The CLIs also write their
// per-turn session transcripts INSIDE that home (`$CLAUDE_CONFIG_DIR/projects/…` for Claude
// Code, `$CODEX_HOME/sessions/…` for Codex), so deleting the home also erases the exact
// per-call detail needed to debug a finished run.
//
// This module lifts ONLY the transcript subtree out of the home BEFORE it is deleted, into a
// retention root, and prunes retained transcripts on a short TTL. The credential lives at the
// home ROOT (`.claude.json` / `auth.json`), never inside `projects/` / `sessions/`, so moving
// just those subdirs keeps the debugging artifact while the existing `rm(home)` still removes
// the credential — the credential-safety property is preserved.
//
// It is meaningful only where the container filesystem outlives the job (the reused local
// warm-pool container, whose next run's sweep honours the TTL); on a per-run cloud container
// torn down with the job it is a harmless no-op. Best-effort throughout: a retention failure
// must NEVER fail an otherwise-successful run.

/** Default retention window: 3 days. Overridable via `HARNESS_TRANSCRIPT_TTL_MS`. */
const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000

/**
 * A marker file dropped into every retention dir THIS module creates. The pruner deletes ONLY
 * dirs carrying it, so pointing `HARNESS_TRANSCRIPT_ROOT` at a shared (non-dedicated) directory
 * can never `rm -rf` unrelated sibling content — we only ever sweep our own retained transcripts.
 */
export const RETENTION_MARKER = '.cf-retained'

/** The retention root (one dir per retained home underneath it). Overridable for operators. */
function retentionRoot(): string {
  const override = process.env.HARNESS_TRANSCRIPT_ROOT?.trim()
  return override && override.length > 0 ? override : join(tmpdir(), 'cf-agent-transcripts')
}

/** The retention TTL in ms, from the env override when it's a positive finite number. */
function ttlMs(): number {
  const raw = Number(process.env.HARNESS_TRANSCRIPT_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS
}

export interface RetainOptions {
  /** A short label for the run/harness, folded into the retention log line. */
  label?: string
  /** The per-job child logger, so the retained path is logged with the run's correlation fields. */
  log?: Logger
}

/**
 * Move the named transcript `subdirs` out of the credential-bearing config `home` into the
 * retention root (so the caller's subsequent `rm(home)` can't take them), then prune retained
 * transcripts older than the TTL. Both steps are best-effort: any failure is swallowed (logged
 * at debug) so this can never fail an otherwise-successful run. Returns the destination dir when
 * something was retained (for logging/tests), else `undefined`.
 */
export async function retainSessionTranscripts(
  home: string,
  subdirs: string[],
  options: RetainOptions = {},
): Promise<string | undefined> {
  const { label, log } = options
  const root = retentionRoot()
  // A filesystem-safe, sortable per-home dir name: an ISO stamp (colons/dots → dashes) + the
  // home's basename (already unique — `mkdtemp` seeded).
  const dest = join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-${basename(home)}`)
  let moved = 0
  try {
    for (const sub of subdirs) {
      const from = join(home, sub)
      try {
        await stat(from)
      } catch {
        continue // the CLI never wrote this subdir this run — nothing to retain
      }
      if (moved === 0) await ensureRetentionDir(dest)
      await moveDir(from, join(dest, sub))
      moved += 1
    }
    if (moved > 0) log?.info('retained session transcripts', { label, dest, subdirs: moved })
  } catch (err) {
    log?.debug('failed to retain session transcripts', {
      label,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  // Prune regardless of whether this run retained anything — a run that moved nothing still gets
  // to sweep the backlog left by earlier runs on a reused container.
  await pruneRetentionRoot(root, ttlMs(), log)
  return moved > 0 ? dest : undefined
}

/** Create a retention dir and stamp it with the ownership marker (see {@link RETENTION_MARKER}). */
async function ensureRetentionDir(dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  await writeFile(join(dest, RETENTION_MARKER), '')
}

/**
 * Move `from` → `to`, preferring a cheap same-filesystem `rename`. When the retention root is on
 * a DIFFERENT device than the config home (an operator override of `HARNESS_TRANSCRIPT_ROOT`),
 * `rename` fails with `EXDEV` — fall back to a recursive copy + remove so the transcript is still
 * lifted out before the caller deletes the home, rather than being silently lost.
 */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * Delete retained-transcript dirs whose mtime is older than `maxAgeMs`. Only dirs carrying the
 * retention marker are candidates — foreign content under a shared retention root is never
 * touched. Best-effort per entry (a concurrent sweep or a vanished dir must not abort the loop).
 */
async function pruneRetentionRoot(root: string, maxAgeMs: number, log?: Logger): Promise<void> {
  const cutoff = Date.now() - maxAgeMs
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return // the root doesn't exist yet (nothing ever retained) — nothing to prune
  }
  for (const name of entries) {
    const path = join(root, name)
    try {
      const info = await stat(path)
      if (!info.isDirectory() || info.mtimeMs >= cutoff) continue
      // Ownership gate: only sweep dirs WE created (they carry the marker). This makes a
      // shared/non-dedicated `HARNESS_TRANSCRIPT_ROOT` safe — unrelated dirs are left alone.
      try {
        await stat(join(path, RETENTION_MARKER))
      } catch {
        continue // not one of ours — never delete it
      }
      await rm(path, { recursive: true, force: true })
      log?.debug('pruned expired session transcripts', { path })
    } catch {
      // best-effort per entry — a concurrent sweep or a vanished dir must not abort the loop
    }
  }
}
