// ---------------------------------------------------------------------------
// Reusable checkout-free MANIFEST-PROBE primitives for custom-provider autodetection.
//
// The built-in provisioning detectors recognize `kubernetes`/`docker-compose` repos from a
// targeted, budget-bounded slice of the repo (see the environments detectors). A CUSTOM
// test-infrastructure provider (a company's own ephemeral-environment convention — e.g. a
// root `.kargo.yml` PLUS `deployment/deploy.kargo.sh` PLUS `deployment/docker-compose.kargo.yml`)
// needs the same power to recognize ITSELF from a repo's shape, extract config, and locate its
// manifest(s) — often a MULTI-FILE signature.
//
// These combinators sit on top of {@link BudgetedRepoScanner} (they never touch the network
// directly), so a custom provider's `detect()` hook composes them against the SAME
// budget/memoization/`readFault` the platform passes in — an arbitration sweep across N
// registered providers reuses one read budget and cache, never N× round-trips. They live in
// the kernel (the shared floor a provider package depends on: kernel + contracts only) so a
// third-party provider package authors detection without importing the integrations layer.
// ---------------------------------------------------------------------------

import type { ProvisioningDetectionNote } from '@cat-factory/contracts'
import { parse as parseYaml, parseAllDocuments } from 'yaml'
import { BudgetedRepoScanner, joinRepoPath, type RepoScanEntry } from './repo-scan.logic.js'

/**
 * How confident a probe is in a match. Deliberately the SAME vocabulary as the contracts'
 * provisioning-detection-note confidence (`high` | `low`), so a `detect()` result maps straight
 * onto a recommendation note without a translation table.
 */
export type ManifestMatchConfidence = 'high' | 'low'

/** True when EVERY path in `paths` exists (one read each, memoized + budget-bounded). */
export async function allPresent(scanner: BudgetedRepoScanner, paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if (!(await scanner.exists(path))) return false
  }
  return true
}

/** True when AT LEAST ONE path in `paths` exists. Short-circuits on the first hit. */
export async function anyPresent(scanner: BudgetedRepoScanner, paths: string[]): Promise<boolean> {
  return (await firstPresent(scanner, paths)) !== null
}

/** The FIRST path in `paths` that exists (priority = list order), or `null` when none do. */
export async function firstPresent(
  scanner: BudgetedRepoScanner,
  paths: string[],
): Promise<string | null> {
  for (const path of paths) {
    if (await scanner.exists(path)) return path
  }
  return null
}

/** Read a file's text, or `null` when it's absent. Thin, named pass-through over the scanner. */
export async function readTextFile(
  scanner: BudgetedRepoScanner,
  path: string,
): Promise<string | null> {
  return scanner.getFile(path)
}

/**
 * Read + parse a single-document YAML file to a plain JS value, or `null` when the file is
 * absent OR the content isn't parseable YAML (a malformed manifest degrades to "no match"
 * rather than throwing mid-scan). The caller narrows the returned `unknown`.
 */
export async function readYamlDoc<T = unknown>(
  scanner: BudgetedRepoScanner,
  path: string,
): Promise<T | null> {
  const text = await scanner.getFile(path)
  if (text === null) return null
  try {
    return (parseYaml(text) ?? null) as T | null
  } catch {
    return null
  }
}

/**
 * Read + parse a MULTI-document YAML file (`---`-separated) to an array of plain JS values.
 * Absent file ⇒ `[]`; a doc that fails to parse is skipped (best-effort), so one bad document
 * doesn't lose the rest. For the common single-doc case prefer {@link readYamlDoc}.
 */
export async function readYamlDocs(
  scanner: BudgetedRepoScanner,
  path: string,
): Promise<unknown[]> {
  const text = await scanner.getFile(path)
  if (text === null) return []
  const out: unknown[] = []
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0) continue
    const value = doc.toJSON()
    if (value !== null && value !== undefined) out.push(value)
  }
  return out
}

/**
 * List the entries of a directory, optionally filtered by `predicate`. A missing directory ⇒
 * `[]` (degrades gracefully). Use for the "match the variable siblings" case — e.g. every
 * `.env.*` file, or the presence of an `ingress/`/`secrets/` subdir — that a fixed path list
 * can't name ahead of time.
 */
export async function listFiles(
  scanner: BudgetedRepoScanner,
  dir: string,
  predicate?: (entry: RepoScanEntry) => boolean,
): Promise<RepoScanEntry[]> {
  const entries = await scanner.listDir(dir)
  return predicate ? entries.filter(predicate) : entries
}

/**
 * A declarative MULTI-FILE signature that identifies a provider from a repo's shape. All paths
 * are relative to the probe root (the service subtree; see {@link matchManifestSignature}'s
 * `root`). This is the turnkey primitive for "several files are needed": the classic case is a
 * provider whose presence is proven only by a set of co-existing files.
 */
export interface ManifestSignature {
  /** EVERY one of these must be present for the signature to match (the required core). */
  required: string[]
  /** Presence of any of these RAISES confidence but is not required (corroborating files/dirs). */
  optional?: string[]
  /**
   * Each inner group is an OR: at least one path from every group must be present. For "one of
   * `compose.yaml` | `docker-compose.yml`" style alternatives that are still mandatory.
   */
  anyOf?: string[][]
}

/** The outcome of matching a {@link ManifestSignature} against a repo. */
export interface ManifestSignatureMatch {
  /** True when all `required` are present and every `anyOf` group is satisfied. */
  matched: boolean
  /** `high` for a corroborated / multi-file match; `low` for a bare single-file one. */
  confidence: ManifestMatchConfidence
  /** The paths that were actually found (required + satisfied `anyOf` picks + matched optionals). */
  matchedPaths: string[]
  /** The required / `anyOf` paths that were absent (empty when `matched`). */
  missing: string[]
}

/**
 * Match a {@link ManifestSignature} against the repo over `scanner`, resolving every path under
 * `opts.root` (the monorepo service subtree, or the repo root when absent). Confidence is `high`
 * when the match rests on two or more corroborating files (a genuine multi-file signature) and
 * `low` for a single-file match, so an author gets sensible confidence for free.
 */
export async function matchManifestSignature(
  scanner: BudgetedRepoScanner,
  signature: ManifestSignature,
  opts: { root?: string } = {},
): Promise<ManifestSignatureMatch> {
  const root = opts.root
  const resolve = (p: string): string => joinRepoPath(root, p)
  const matchedPaths: string[] = []
  const missing: string[] = []

  for (const path of signature.required) {
    const full = resolve(path)
    if (await scanner.exists(full)) matchedPaths.push(full)
    else missing.push(full)
  }

  for (const group of signature.anyOf ?? []) {
    const hit = await firstPresent(scanner, group.map(resolve))
    if (hit) matchedPaths.push(hit)
    // Record the whole group as missing (as a single "one of ..." token) when none resolved.
    else missing.push(group.map(resolve).join(' | '))
  }

  for (const path of signature.optional ?? []) {
    const full = resolve(path)
    if (await scanner.exists(full)) matchedPaths.push(full)
  }

  const matched = missing.length === 0
  const confidence: ManifestMatchConfidence = matched && matchedPaths.length >= 2 ? 'high' : 'low'
  return { matched, confidence, matchedPaths, missing }
}

// --- The custom-provider `detect()` authoring contract -------------------------------------
// The types a custom test-infrastructure provider implements to participate in autodetection.
// They live in the kernel (not integrations) so a provider package — kernel + contracts only —
// authors a `detect()` hook without importing the integrations layer. The integrations
// detector builds the {@link CustomManifestDetectionContext} (one shared, budget-bounded
// scanner rooted at the service subtree) and maps the returned {@link CustomManifestDetection}
// onto the wire recommendation.

/** A single extracted key/value the SPA prefills into the connect/provision form. */
export interface CustomProviderConfigSeed {
  key: string
  value: string
}

/**
 * What the platform hands a custom provider's `detect()` hook. `scanner` is a shared
 * {@link BudgetedRepoScanner} (already rooted-agnostic and budget-bounded) — compose the probe
 * primitives above against it. `directory` is the monorepo service subtree ('' / absent ⇒ repo
 * root); resolve your signature paths under it (pass it as `matchManifestSignature`'s `root`).
 */
export interface CustomManifestDetectionContext {
  /** The shared, budget-bounded, memoized checkout-free reader — use the probe primitives on it. */
  scanner: BudgetedRepoScanner
  /** Service subdirectory within the repo (monorepo); '' / absent ⇒ the repo root. */
  directory?: string
  /** The git ref being read at (informational; the scanner already reads at it). */
  gitRef?: string
  /** The service's CURRENT manifest path, if any — honor a value that already resolves. */
  currentPath?: string
  /** This custom type's declared `defaultManifestPath`, if any (a seed for the path search). */
  defaultManifestPath?: string
}

/**
 * What a custom provider's `detect()` returns. `matched: false` (or a `null` return from the
 * hook) means "this is not my provider" — the arbitration sweep skips it. When matched, the
 * detector maps `manifestPath` onto `provisioning.manifestPath`, `configSeed` onto the
 * recommendation's `customConfigSeed`, `secondaryPaths` onto `secondaryManifestPaths`, and
 * `notes` onto the recommendation notes.
 */
export interface CustomManifestDetection {
  /** True when this provider recognizes the repo. `false` ⇒ not a match (skipped in arbitration). */
  matched: boolean
  /** Confidence in the match — drives arbitration ranking and the surfaced note. */
  confidence: ManifestMatchConfidence
  /** The primary in-repo manifest path to prefill (repo-relative). */
  manifestPath?: string
  /** Other files the signature matched, surfaced for context (repo-relative). */
  secondaryPaths?: string[]
  /** Extracted config (health port/path, deploy command, …) to prefill the form. */
  configSeed?: CustomProviderConfigSeed[]
  /** Optional human-readable rationale notes for the confirm UI. */
  notes?: ProvisioningDetectionNote[]
}
