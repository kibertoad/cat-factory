import type { RepoContentEntry } from '@cat-factory/kernel'
import { isContractCandidatePath } from '@cat-factory/kernel'
import { SERVICE_MANIFEST_FILE } from './foundational-source.logic.js'

// ---------------------------------------------------------------------------
// The `folder`-mode walk: find every candidate contract document under one repo folder,
// optionally descending into its subfolders (backend/docs/adr/0031-foundational-services.md).
//
// The directory listing is INJECTED rather than taken as a GitHub client, so the walk's whole
// contract — ordering, the caps, what counts as a candidate — is unit-testable with no client
// and both facades get identical behaviour by construction.
// ---------------------------------------------------------------------------

/**
 * How many subfolder levels below the scanned root a recursive walk descends. Deep enough for
 * any real spec layout (`specs/<domain>/<version>/…`), shallow enough that a link pointed at a
 * repo root cannot walk a whole monorepo.
 */
export const MAX_FOLDER_SCAN_DEPTH = 8

/**
 * How many directory listings ONE scan may perform. This is the cost bound that matters: every
 * directory is a separate upstream read, and a folder link is the one source shape whose reach
 * nobody enumerated by hand.
 */
export const MAX_FOLDER_SCAN_DIRECTORIES = 200

/**
 * How many candidate contract files one folder source may take. Each becomes a stored document
 * that a declaring design's consumer folds into its context, so this bounds what a single link
 * can put in front of an agent.
 */
export const MAX_FOLDER_CONTRACT_FILES = 100

/** Lists one repo directory at the scan's pinned ref. */
export type ListRepoDirectory = (path: string) => Promise<RepoContentEntry[]>

export interface FolderScanResult {
  /** Candidate contract file paths, shallowest-first then by name. */
  paths: string[]
  /** The OPTIONAL `service.md` sitting at the folder root, if there is one. */
  manifestPath: string | null
  /**
   * A cap stopped the walk short, so {@link paths} is a PREFIX of what the folder holds. The
   * caller reports it; it is deliberately NOT treated as a transient failure, because a
   * re-read would truncate identically and the source would never look caught up.
   */
  truncated: boolean
}

/**
 * Walk `root` for contract documents.
 *
 * BREADTH-first with each listing sorted by name, which makes two things true at once: the
 * result is deterministic across syncs (so a truncated scan keeps the same contracts rather
 * than flapping), and the cap falls on the DEEPEST, least-specific files — a root-level
 * `openapi.yaml` is never dropped in favour of something nested six levels down.
 *
 * Only files whose extension could yield a contract format are returned; the caller still has
 * to read each body to know. That pre-filter is what keeps a scan's file reads proportional to
 * the candidates rather than to everything the folder happens to contain.
 */
export async function scanContractFolder(params: {
  listDir: ListRepoDirectory
  root: string
  recursive: boolean
}): Promise<FolderScanResult> {
  const { listDir, root, recursive } = params
  const paths: string[] = []
  let manifestPath: string | null = null
  let truncated = false
  let listings = 0

  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
  while (queue.length > 0 && paths.length < MAX_FOLDER_CONTRACT_FILES) {
    if (listings >= MAX_FOLDER_SCAN_DIRECTORIES) {
      truncated = true
      break
    }
    const { path, depth } = queue.shift() as { path: string; depth: number }
    const entries = await listDir(path)
    listings++
    // Code-unit order, locale-independent — the same rule the `directory` reconcile sorts by,
    // so neither walk's outcome depends on ICU collation.
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of sorted) {
      if (entry.type === 'file') {
        if (depth === 0 && entry.name.toLowerCase() === SERVICE_MANIFEST_FILE) {
          manifestPath = entry.path
          continue
        }
        if (!isContractCandidatePath(entry.path)) continue
        if (paths.length >= MAX_FOLDER_CONTRACT_FILES) {
          truncated = true
          break
        }
        paths.push(entry.path)
        continue
      }
      if (entry.type !== 'dir' || !recursive) continue
      if (depth + 1 > MAX_FOLDER_SCAN_DEPTH) {
        truncated = true
        continue
      }
      queue.push({ path: entry.path, depth: depth + 1 })
    }
  }
  // Anything left queued when the file cap ended the walk is unvisited, so the result is a
  // prefix — say so rather than letting a full-looking list stand for a partial folder.
  if (queue.length > 0 && paths.length >= MAX_FOLDER_CONTRACT_FILES) truncated = true

  return { paths, manifestPath, truncated }
}
