// ---------------------------------------------------------------------------
// Documentation-refresh preset — repo LAYOUT AUTODETECTION (slice 6).
//
// A deterministic, bounded, checkout-free heuristic that proposes the docs-refresh
// preset's placement DEFAULTS (where docs live, whether the repo documents per-service,
// which subfolders hold diagrams / business rules) by reading a targeted, tiny slice of
// the repo over a {@link DocsRepoReader}-shaped reader. No LLM, no clone — just a handful
// of directory listings plus the root workspace manifests. Mirrors the spirit of
// `provision-detect.logic.ts` (integrations): high-confidence facts are inferred
// deterministically; everything is a NON-BINDING prefill the user (and later the analyst
// during planning) confirms or overrides.
//
// This is the pure logic behind the preset's `detect` hook (slice 8), which maps the
// result onto the form's `InitiativePresetInputs`. Detected values are FORM DEFAULTS: a
// user edit wins, and both freeze on `presetInputs` at create. The analyst confirms /
// refines placement at planning time and records deviations as `decisions` — it never
// silently rewrites the frozen inputs. See
// `docs/initiatives/initiative-presets-and-docs-refresh.md` (slice 6).
// ---------------------------------------------------------------------------

import { BudgetedRepoScanner, joinRepoPath } from '@cat-factory/kernel'

/**
 * The narrow slice of the checkout-free repo API the detector needs — a `RepoFiles`
 * satisfies it structurally, and a test supplies an in-memory fake. A MISSING path yields
 * `null` / `[]`, so the heuristics degrade gracefully on partial repos. A genuine read
 * fault (auth/permission revoked, rate limit, transport error) may THROW — the real
 * GitHub/GitLab reader throws on any non-404 status. The detector NEVER propagates it: the
 * shared {@link BudgetedRepoScanner} swallows the fault (records it, keeps scanning
 * best-effort) and this probe simply ignores `readFault`, so it can only ever return
 * defaults, never reject — a prefill must never block create.
 */
export interface DocsRepoReader {
  getFile(path: string, gitRef?: string): Promise<{ content: string } | null>
  listDirectory(
    path: string,
    gitRef?: string,
  ): Promise<{ name: string; type: string; path: string }[]>
}

/**
 * The detected documentation layout — the docs-refresh preset's placement DEFAULTS plus two
 * intel facts for the analyst. All fields are always present (a partial/unreadable repo
 * yields the conventional defaults), so the caller never has to null-check.
 */
export interface DocsLayoutDetection {
  /**
   * How docs are placed: `root` (one top-level docs tree) vs `per-service` (each package
   * carries its own docs — the monorepo shape). Drives the `placementMode` form default.
   */
  placementMode: 'root' | 'per-service'
  /** The repo-relative docs root directory (no trailing slash), e.g. `docs`. */
  docsRoot: string
  /** The repo-relative diagrams directory (no trailing slash), e.g. `docs/diagrams`. */
  diagramsDir: string
  /** The repo-relative business-rules directory (no trailing slash), e.g. `docs/business-logic`. */
  businessRulesDir: string
  /**
   * Whether the repo already carries mermaid diagram SOURCES — a standalone `.mmd`/`.mermaid`
   * file or a `mermaid` directory in a scanned location. A hint for the analyst; it is NOT
   * authoritative (embedded ```mermaid fences inside `.md` files aren't detected — reading
   * doc bodies is out of the probe's checkout-free budget; the analyst finds those after clone).
   */
  hasExistingMermaid: boolean
  /**
   * Whether the repo looks like a monorepo (a workspace manifest, a `workspaces` package.json
   * field, or a conventional `packages`/`apps`/`services`/`libs` directory). Distinct from
   * `placementMode`: a monorepo can still keep one root docs tree.
   */
  monorepo: boolean
}

const DEFAULT_DOCS_ROOT = 'docs'
// Root directory names that hold documentation, most-conventional first (first present wins).
const DOCS_ROOT_NAMES = ['docs', 'doc', 'documentation']
// Subfolder names (under the docs root) that hold diagrams, most-conventional first.
const DIAGRAMS_DIR_NAMES = ['diagrams', 'diagram', 'architecture', 'arch']
// Subfolder names (under the docs root) that hold business rules / domain docs. `business-logic`
// first — it matches the `business-documenter` agent's default placement.
const BUSINESS_RULES_DIR_NAMES = ['business-logic', 'business', 'domain', 'rules']
// Conventional monorepo package roots — listed to sample per-service docs placement.
const WORKSPACE_DIRS = ['packages', 'apps', 'services', 'libs']
// Root files that declare a workspace/monorepo (presence alone is the signal — never parsed).
const MONOREPO_MANIFESTS = [
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'nx.json',
  'rush.json',
]
// Standalone mermaid source extensions (directory-listing signal for `hasExistingMermaid`).
const MERMAID_FILE_RE = /\.(mmd|mermaid)$/i

// The most packages we sample when deciding per-service placement — bounds the read fan-out.
const MAX_SAMPLED_PACKAGES = 6
// Hard ceiling on reads so a pathological repo can't fan out without bound. A typical repo
// resolves in ~10 reads (root + a root manifest + the docs tree + a few sampled packages); the
// cap only bites on a decoy-heavy tree, where the scan simply stops and returns what it has.
const READ_BUDGET = 32

/** Immediate child directory names of a listing. */
function dirNames(entries: { name: string; type: string }[]): Set<string> {
  return new Set(entries.filter((e) => e.type === 'dir').map((e) => e.name))
}

/** Immediate child file names of a listing. */
function fileNames(entries: { name: string; type: string }[]): Set<string> {
  return new Set(entries.filter((e) => e.type !== 'dir').map((e) => e.name))
}

/** The first of `candidates` present as a child dir of `dirs`, else undefined. */
function firstPresent(dirs: Set<string>, candidates: string[]): string | undefined {
  return candidates.find((c) => dirs.has(c))
}

/** True when any listed entry is a standalone mermaid source file or a `mermaid` directory. */
function listingHasMermaid(entries: { name: string; type: string }[]): boolean {
  return entries.some(
    (e) =>
      (e.type === 'dir' && e.name === 'mermaid') ||
      (e.type !== 'dir' && MERMAID_FILE_RE.test(e.name)),
  )
}

/**
 * Read the root `package.json` and report whether it declares a `workspaces` field (the
 * npm/yarn/bun monorepo marker). Best-effort: an absent/unparseable manifest ⇒ false. This is
 * the only file the probe reads beyond directory listings, and it is a root workspace manifest.
 */
async function hasNpmWorkspaces(scanner: BudgetedRepoScanner): Promise<boolean> {
  const content = await scanner.getFile('package.json')
  if (!content) return false
  try {
    const pkg = JSON.parse(content) as { workspaces?: unknown }
    const ws = pkg.workspaces
    // Array form (`["packages/*"]`) OR yarn's object form (`{ packages: ["packages/*"] }`) — a
    // monorepo marker only when it actually declares globs. An empty `[]`/`{}` (or `{ nohoist }`
    // with no `packages`) declares no workspaces, so it's not a monorepo signal.
    if (Array.isArray(ws)) return ws.length > 0
    if (ws !== null && typeof ws === 'object') {
      const packages = (ws as { packages?: unknown }).packages
      return Array.isArray(packages) && packages.length > 0
    }
    return false
  } catch {
    return false
  }
}

/**
 * Sample up to {@link MAX_SAMPLED_PACKAGES} packages across the present workspace dirs and count
 * how many carry their own docs directory. Returns the vote (`sampled`/`withDocs`) plus whether
 * any sampled package held a mermaid source. Bounded by the sample cap + the global read budget.
 */
async function samplePackageDocs(
  scanner: BudgetedRepoScanner,
  workspaceDirs: string[],
): Promise<{ sampled: number; withDocs: number; mermaid: boolean }> {
  let sampled = 0
  let withDocs = 0
  let mermaid = false
  for (const wsDir of workspaceDirs) {
    if (sampled >= MAX_SAMPLED_PACKAGES) break
    const children = (await scanner.listDir(wsDir)).filter((e) => e.type === 'dir')
    for (const child of children) {
      if (sampled >= MAX_SAMPLED_PACKAGES) break
      sampled++
      const entries = await scanner.listDir(joinRepoPath(wsDir, child.name))
      if (firstPresent(dirNames(entries), DOCS_ROOT_NAMES)) withDocs++
      if (listingHasMermaid(entries)) mermaid = true
    }
  }
  return { sampled, withDocs, mermaid }
}

/**
 * Detect the documentation layout of a repo for the docs-refresh preset's form prefill.
 *
 * Deterministic, bounded (a hard read budget), and TOTAL — it never throws and never rejects,
 * so an unwired GitHub / a partial or unreadable repo simply yields the conventional defaults
 * (`root` placement, `docs`, `docs/diagrams`, `docs/business-logic`). The result is a set of
 * non-binding FORM DEFAULTS; the user's edits win and the analyst confirms placement at
 * planning time.
 */
export async function detectDocsLayout(reader: DocsRepoReader): Promise<DocsLayoutDetection> {
  const scanner = new BudgetedRepoScanner(reader, READ_BUDGET)

  const rootEntries = await scanner.listDir('')
  const rootDirs = dirNames(rootEntries)
  const rootFiles = fileNames(rootEntries)

  // --- docs root -------------------------------------------------------------------------------
  const docsRoot = firstPresent(rootDirs, DOCS_ROOT_NAMES) ?? DEFAULT_DOCS_ROOT
  let diagramsDir = joinRepoPath(docsRoot, 'diagrams')
  let businessRulesDir = joinRepoPath(docsRoot, 'business-logic')
  // Root listing signal: a standalone `.mmd`/`.mermaid` file OR a `mermaid` directory (the root
  // is a scanned location, so both halves of the signal count here — not just the file half).
  let hasExistingMermaid = listingHasMermaid(rootEntries)

  // --- known subfolders under the docs root ----------------------------------------------------
  if (rootDirs.has(docsRoot)) {
    const docsEntries = await scanner.listDir(docsRoot)
    const docsDirs = dirNames(docsEntries)
    const diagramsChild = firstPresent(docsDirs, DIAGRAMS_DIR_NAMES)
    if (diagramsChild) diagramsDir = joinRepoPath(docsRoot, diagramsChild)
    const businessChild = firstPresent(docsDirs, BUSINESS_RULES_DIR_NAMES)
    if (businessChild) businessRulesDir = joinRepoPath(docsRoot, businessChild)
    hasExistingMermaid = hasExistingMermaid || listingHasMermaid(docsEntries)
    // Peek inside the diagrams dir once for standalone mermaid sources (budget permitting).
    if (diagramsChild && !hasExistingMermaid) {
      hasExistingMermaid = listingHasMermaid(
        await scanner.listDir(joinRepoPath(docsRoot, diagramsChild)),
      )
    }
  }

  // --- monorepo shape + per-service placement --------------------------------------------------
  const workspaceDirs = WORKSPACE_DIRS.filter((d) => rootDirs.has(d))
  const monorepoManifest =
    MONOREPO_MANIFESTS.some((m) => rootFiles.has(m)) || (await hasNpmWorkspaces(scanner))
  const monorepo = monorepoManifest || workspaceDirs.length > 0

  let placementMode: 'root' | 'per-service' = 'root'
  if (monorepo && workspaceDirs.length > 0) {
    const { sampled, withDocs, mermaid } = await samplePackageDocs(scanner, workspaceDirs)
    hasExistingMermaid = hasExistingMermaid || mermaid
    // Per-service when MOST sampled packages document themselves (a strict majority — an even
    // split stays on the safe `root` default). A monorepo we can't sample (manifest-only, no
    // conventional package dir) stays `root` too — the safe, common default.
    if (sampled > 0 && withDocs * 2 > sampled) placementMode = 'per-service'
  }

  return { placementMode, docsRoot, diagramsDir, businessRulesDir, hasExistingMermaid, monorepo }
}
