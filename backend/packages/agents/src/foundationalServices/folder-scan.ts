import type { FolderScanCoverage } from '@cat-factory/contracts'
import type { RepoContentEntry } from '@cat-factory/kernel'
import { isContractCandidatePath } from '@cat-factory/kernel'
import pMap from 'p-map'
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

/**
 * How many of a level's directory listings are in flight at once. The walk's cost bound is
 * {@link MAX_FOLDER_SCAN_DIRECTORIES} reads; this is what stops those reads from being paid
 * one round trip at a time, which on a deep tree is the difference between a sync that takes
 * seconds and one that takes minutes.
 */
export const FOLDER_SCAN_CONCURRENCY = 8

/**
 * How large a candidate file may be before the walk declines to read it.
 *
 * Pinned to the host contents API's own ceiling rather than chosen freely: above 1 MiB GitHub
 * answers a file read with EMPTY content, so fetching one can only ever cost a round trip and
 * produce a skip. Declining it up front turns that into a reported skip with no read, and keeps
 * a multi-megabyte document out of the YAML parser on the runtimes that do return it.
 *
 * A cap on the WALK, not on what a contract may be: `files` and `directory` sources name their
 * documents, so nobody is protected from a file they asked for by name. It is the unbounded
 * discovery that needs a bound.
 */
export const MAX_FOLDER_CONTRACT_FILE_BYTES = 1024 * 1024

/** Lists one repo directory at the scan's pinned ref. */
export type ListRepoDirectory = (path: string) => Promise<RepoContentEntry[]>

/** One directory the walk has queued, with the level it sits on. */
interface ScanDirectory {
  path: string
  depth: number
}

/** What ONE directory's listing contributes to the walk. */
interface DirectoryYield {
  /** Candidate contract files, in name order. */
  files: string[]
  /** Subdirectories to visit on the next level, in name order. */
  children: ScanDirectory[]
  /** The optional `service.md`, only ever read off the ROOT listing. */
  manifestPath: string | null
  /** A subdirectory was refused for sitting past {@link MAX_FOLDER_SCAN_DEPTH}. */
  depthCapped: boolean
  /** Candidates declined unread for exceeding {@link MAX_FOLDER_CONTRACT_FILE_BYTES}. */
  oversize: number
}

/**
 * Classify one directory's entries. Pure and per-directory, so the walk above stays a loop over
 * levels and this stays the single place that decides what an entry IS.
 *
 * It deliberately applies no cap of its own: the file cap is a property of the WALK (it counts
 * across directories), so applying it here would either need the running total threaded in or
 * would silently cap per directory.
 */
function readDirectoryListing(
  dir: ScanDirectory,
  entries: RepoContentEntry[],
  recursive: boolean,
): DirectoryYield {
  const files: string[] = []
  const children: ScanDirectory[] = []
  let manifestPath: string | null = null
  let depthCapped = false
  let oversize = 0
  // Code-unit order, locale-independent — the same rule the `directory` reconcile sorts by, so
  // neither walk's outcome depends on ICU collation.
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const entry of sorted) {
    if (entry.type === 'file') {
      if (dir.depth === 0 && entry.name.toLowerCase() === SERVICE_MANIFEST_FILE) {
        manifestPath = entry.path
        continue
      }
      if (!isContractCandidatePath(entry.path)) continue
      // A size the listing does not carry is not a size we may assume is over the cap: the
      // read still has to happen, and an oversized body then reads back empty and is skipped
      // there. Declining on an ABSENT size would silently drop contracts on any host whose
      // listing omits it.
      if (entry.size !== undefined && entry.size > MAX_FOLDER_CONTRACT_FILE_BYTES) {
        oversize++
        continue
      }
      files.push(entry.path)
      continue
    }
    if (entry.type !== 'dir' || !recursive) continue
    // A directory we decline to descend into is dropped COVERAGE, whether or not it happens to
    // hold a contract — we cannot know which without the listing the cap just refused. So
    // reporting truncation here is the only honest answer, not an over-report.
    if (dir.depth + 1 > MAX_FOLDER_SCAN_DEPTH) {
      depthCapped = true
      continue
    }
    children.push({ path: entry.path, depth: dir.depth + 1 })
  }
  return { files, children, manifestPath, depthCapped, oversize }
}

export interface FolderScanResult {
  /** Candidate contract file paths, shallowest-first then by name. */
  paths: string[]
  /** The OPTIONAL `service.md` sitting at the folder root, if there is one. */
  manifestPath: string | null
  /**
   * How much of the folder this walk saw. The caller BRANCHES on it, because "found no
   * candidates" means opposite things depending on whether the walk finished: see the
   * reconcile's three-way disposition.
   */
  coverage: FolderScanCoverage
  /**
   * Candidates the walk declined to read at all (too large — {@link
   * MAX_FOLDER_CONTRACT_FILE_BYTES}). Reported so a cap never drops a file in silence; the
   * caller folds it into the sync's skipped count beside the files that failed on their bodies.
   */
  skippedCandidates: number
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
  let skippedCandidates = 0
  // Git cannot represent an empty directory, so a root that lists NOTHING is a root that is not
  // there — the host answers a missing path with an empty listing rather than an error. That
  // makes this the one observation separating "the folder holds no contracts" from "the folder
  // is gone", which the caller must tell apart to know whether retiring the service is warranted.
  let rootIsEmpty = false

  // One LEVEL at a time. The listings within a level are independent of each other, so they run
  // concurrently; the level boundary is what keeps the walk breadth-first, and therefore keeps
  // the visit order — and every cap's outcome — identical to a one-at-a-time walk.
  let frontier: ScanDirectory[] = [{ path: root, depth: 0 }]
  while (frontier.length > 0 && paths.length < MAX_FOLDER_CONTRACT_FILES) {
    const budget = MAX_FOLDER_SCAN_DIRECTORIES - listings
    if (budget <= 0) {
      truncated = true
      break
    }
    // The frontier is already in visit order, so taking its first `budget` entries drops exactly
    // the directories a sequential walk would have run out of listings before reaching.
    const batch = frontier.slice(0, budget)
    if (batch.length < frontier.length) truncated = true
    listings += batch.length
    // `pMap` resolves in INPUT order, so the decision pass below still sees the level in the
    // order the walk defines rather than the order the network happened to answer in.
    const listed = await pMap(batch, async (dir) => ({ dir, entries: await listDir(dir.path) }), {
      concurrency: FOLDER_SCAN_CONCURRENCY,
    })

    const next: ScanDirectory[] = []
    for (const { dir, entries } of listed) {
      if (dir.depth === 0 && entries.length === 0) rootIsEmpty = true
      const yielded = readDirectoryListing(dir, entries, recursive)
      if (yielded.manifestPath) manifestPath = yielded.manifestPath
      if (yielded.depthCapped) truncated = true
      skippedCandidates += yielded.oversize
      for (const file of yielded.files) {
        if (paths.length >= MAX_FOLDER_CONTRACT_FILES) {
          truncated = true
          break
        }
        paths.push(file)
      }
      next.push(...yielded.children)
    }
    frontier = next
  }
  // Anything left queued when the file cap ended the walk is unvisited, so the result is a
  // prefix — say so rather than letting a full-looking list stand for a partial folder.
  if (frontier.length > 0 && paths.length >= MAX_FOLDER_CONTRACT_FILES) truncated = true

  // `missing` outranks `truncated` because it cannot co-occur with it in any real walk: an
  // absent root queues no children, so nothing is left for a cap to refuse. Stating the
  // precedence anyway keeps the invariant on the page rather than in the reader's head.
  const coverage: FolderScanCoverage = rootIsEmpty
    ? 'missing'
    : truncated
      ? 'truncated'
      : 'complete'
  return { paths, manifestPath, coverage, skippedCandidates }
}
