import type { ValidationEcosystem } from '@cat-factory/contracts'
import { VALIDATION_MAX_CHECKS } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// PRE-PR VALIDATION AUTODETECTION — the pure half.
//
// An operator configuring a service's pre-PR validation checks
// (`docs/initiatives/pre-pr-validation.md`) has to know the repo's ecosystem and its
// conventions by heart. This module derives a SUGGESTION from what the repo actually
// contains: which manifests sit at its root, which scripts/targets they declare, and
// which tool configs are checked in.
//
// It is deliberately pure — it takes a {@link RepoSurface} (the root listing plus the
// decoded content of a bounded set of manifests) and returns commands. Reading that
// surface is the caller's job (`detectValidationChecksFromRepo` in
// `@cat-factory/integrations`), which keeps every rule here unit-testable against a
// literal, and keeps the whole feature runtime-symmetric: the reader talks only to the
// checkout-free `RepoFiles` port.
//
// Governing rule for what may be suggested: PREFER THE REPO'S OWN EVIDENCE. A command is
// suggested when the repo declares it (an npm script, a Make target, a checked-in tool
// config) or when it is the ecosystem's canonical, non-opinionated verification (`go test
// ./...`, `cargo test`, `mvn verify`). An opinionated gate that a repo has never run — a
// formatter check, a `-D warnings` linter — is suggested ONLY when its config file is
// present, because suggesting it otherwise produces a check that fails on the very first
// run for reasons the coding agent did not cause.
//
// The result is a SUGGESTION, never a write: the panel populates its rows with it and the
// operator saves (or edits, or discards) as usual.
// ---------------------------------------------------------------------------

/**
 * What a suggested check is FOR. Used only to order the suggestions (an install must
 * precede the commands that need it; a fast lint should fail before a slow build) — it is
 * not persisted, and the wire shape carries `{ label, command }` like any other check.
 */
export type ValidationCheckRole = 'install' | 'format' | 'lint' | 'typecheck' | 'test' | 'build'

/**
 * Suggestion ordering within one ecosystem. Setup first, then the static checks cheapest
 * first (a formatter diff should fail before a type check), then `build` BEFORE `test` —
 * a compile error is the faster, clearer failure, and a suite whose fixtures come from
 * build output would otherwise run against a tree that was never built.
 */
const ROLE_ORDER: readonly ValidationCheckRole[] = [
  'install',
  'format',
  'lint',
  'typecheck',
  'build',
  'test',
]

/** One root-directory entry, as the `RepoFiles` listing reports it. */
export interface RepoRootEntry {
  name: string
  /** `file` | `dir` | `symlink` | `submodule` — the provider's own vocabulary. */
  type: string
}

/**
 * Everything the detector is allowed to see: the repo root's entries, plus the decoded
 * content of the manifests named in {@link VALIDATION_DETECTION_CONTENT_FILES} that were
 * actually present. A manifest the reader could not fetch is simply absent from `files`,
 * which degrades that ecosystem to presence-only rules rather than failing detection.
 */
export interface RepoSurface {
  entries: RepoRootEntry[]
  files: Record<string, string>
}

/** One suggested check plus the role that orders it. */
export interface DetectedCheck {
  label: string
  command: string
  role: ValidationCheckRole
}

/** What one ecosystem detector produced. `null` ⇒ the ecosystem is absent or yielded nothing. */
export interface EcosystemDetection {
  ecosystem: ValidationEcosystem
  checks: DetectedCheck[]
}

/** The detection result, as the endpoint returns it (minus the transport `status`). */
export interface ValidationDetectionResult {
  /** Every ecosystem that contributed at least one check, in canonical order. */
  ecosystems: ValidationEcosystem[]
  checks: { label: string; command: string }[]
  /** Whether {@link VALIDATION_MAX_CHECKS} dropped suggestions the detectors produced. */
  truncated: boolean
  /**
   * The suggested DEPENDENCY PREPOPULATION command: every detected ecosystem's install role,
   * chained with `&&` (so a failed install stops rather than letting the next one run against a
   * broken tree). Derived from the RAW detections, deliberately — an ecosystem that declares an
   * install but nothing to verify contributes no check at all, and that repo is precisely the
   * one whose agent most needs its dependencies present. Absent when nothing detected an install.
   */
  dependencyInstall?: string
}

/**
 * A read-only view over a {@link RepoSurface} with the lookups every detector needs. Names
 * are matched case-INSENSITIVELY because the conventions genuinely vary (`Makefile` vs
 * `makefile`, `justfile` vs `Justfile`) and a case-sensitive miss reads to an operator as
 * "the detector is broken", not as "your file is spelled differently".
 */
export class RepoView {
  private readonly filesByLowerName = new Map<string, string>()
  private readonly dirNames = new Set<string>()
  private readonly fileNames = new Set<string>()

  constructor(surface: RepoSurface) {
    for (const entry of surface.entries) {
      const name = entry.name.toLowerCase()
      if (entry.type === 'dir') this.dirNames.add(name)
      else this.fileNames.add(name)
    }
    for (const [name, content] of Object.entries(surface.files)) {
      this.filesByLowerName.set(name.toLowerCase(), content)
    }
  }

  /** Whether a FILE with this name sits at the repo root. */
  has(name: string): boolean {
    return this.fileNames.has(name.toLowerCase())
  }

  /** Whether any of these files sits at the repo root. */
  hasAny(...names: string[]): boolean {
    return names.some((n) => this.has(n))
  }

  /** Whether a DIRECTORY with this name sits at the repo root. */
  hasDir(name: string): boolean {
    return this.dirNames.has(name.toLowerCase())
  }

  /** Whether any root FILE ends with this (lowercased) suffix — e.g. `.sln`, `.csproj`. */
  hasFileWithSuffix(suffix: string): boolean {
    const lower = suffix.toLowerCase()
    for (const name of this.fileNames) if (name.endsWith(lower)) return true
    return false
  }

  /** The decoded content of a root manifest the reader fetched, or undefined. */
  read(name: string): string | undefined {
    return this.filesByLowerName.get(name.toLowerCase())
  }

  /** The first of these root manifests whose content was fetched. */
  readAny(...names: string[]): string | undefined {
    for (const name of names) {
      const content = this.read(name)
      if (content !== undefined) return content
    }
    return undefined
  }

  /**
   * A root manifest parsed as JSON, or undefined when it is absent or malformed. A repo
   * with an unparseable `package.json` is a real thing (a merge conflict, a template
   * placeholder); it degrades that ecosystem to its presence-only rules rather than
   * failing the whole detection.
   */
  json(name: string): Record<string, unknown> | undefined {
    const raw = this.read(name)
    if (raw === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      // silent-catch-ok: a malformed manifest is a detection MISS, not an error to report —
      // the ecosystem falls back to its presence-only rules and the operator still gets the
      // rest of the suggestions.
      return undefined
    }
  }
}

/** A detector: recognise an ecosystem on the surface and propose its checks. */
export type EcosystemDetector = (view: RepoView) => EcosystemDetection | null

/**
 * Compose one ecosystem's result, dropping an ecosystem whose preconditions produced nothing
 * at all.
 *
 * An ecosystem that produced ONLY setup commands is KEPT here and filtered later, in
 * {@link detectValidationChecks}. That split matters: an `install` on its own verifies nothing,
 * so it must not become a suggested CHECK (it would open a PR on a checkout no command ever
 * inspected, while costing every run the install) — but it is exactly the command DEPENDENCY
 * PREPOPULATION wants, and nulling the detection here would discard it before anything could
 * read it. One place now decides what a verification-less ecosystem means for each output.
 */
export function ecosystem(
  id: ValidationEcosystem,
  checks: (DetectedCheck | null)[],
): EcosystemDetection | null {
  const kept = checks.filter((c): c is DetectedCheck => c !== null)
  if (kept.length === 0) return null
  return { ecosystem: id, checks: kept }
}

/** Whether an ecosystem proposed anything that actually VERIFIES the checkout. */
function verifies(detection: EcosystemDetection): boolean {
  return detection.checks.some((c) => c.role !== 'install')
}

/** Build a check, or nothing when its precondition didn't hold (keeps detectors declarative). */
export function check(
  role: ValidationCheckRole,
  label: string,
  command: string | null | undefined,
): DetectedCheck | null {
  return command ? { role, label, command } : null
}

/**
 * Run the detectors over a repo surface and return the suggested checks.
 *
 * LANGUAGE ecosystems are detected first and independently — a polyglot repo (a Go service
 * with a Node SPA beside it) gets both, because either half can break the PR. TASK RUNNERS
 * (`make`, `just`, `task`) are a FALLBACK, used only when no language ecosystem produced
 * anything: in a repo that has both, the language commands are the specific ones, and
 * suggesting `make test` beside `go test ./...` would run the same suite twice on every run.
 */
export function detectValidationChecks(
  surface: RepoSurface,
  detectors: {
    language: readonly EcosystemDetector[]
    taskRunner: readonly EcosystemDetector[]
  },
): ValidationDetectionResult {
  const view = new RepoView(surface)
  const run = (list: readonly EcosystemDetector[]) =>
    list.map((d) => d(view)).filter((d): d is EcosystemDetection => d !== null)

  const language = run(detectors.language)
  // The task-runner fallback keys off whether a language ecosystem produced a VERIFYING check,
  // not merely a detection: a repo whose only language hit is an install (a `package.json` with
  // no scripts) still has nothing checking it, so `make test` is as much the right fallback as
  // it was before install-only detections survived `ecosystem()`.
  const hits = language.some(verifies) ? language : [...language, ...run(detectors.taskRunner)]

  // Grouped by ecosystem (so an install stays with the commands that need it), role-ordered
  // within each group, and in the detectors' own canonical order across groups. A group with
  // nothing to verify contributes NO check and, importantly, consumes none of the cap below —
  // its install still reaches `dependencyInstall`.
  const ordered = hits
    .filter(verifies)
    .flatMap((hit) =>
      [...hit.checks]
        .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
        .map((c) => ({ ...c, ecosystem: hit.ecosystem })),
    )
  // The cap can slice an ecosystem mid-group and leave only its `install` behind — a command
  // that verifies nothing, costs every run its install time, and reads as "this ecosystem is
  // covered". Drop any group the cut reduced to setup.
  const capped = ordered.slice(0, VALIDATION_MAX_CHECKS)
  const verified = new Set(capped.filter((c) => c.role !== 'install').map((c) => c.ecosystem))
  const kept = capped.filter((c) => verified.has(c.ecosystem))
  // Every detected ecosystem's install, INCLUDING one whose group never reached `checks` —
  // deduplicated, because two detectors can legitimately land on the same command.
  const installs = [
    ...new Set(
      hits.flatMap((h) => h.checks.filter((c) => c.role === 'install').map((c) => c.command)),
    ),
  ]

  return {
    ecosystems: hits.map((h) => h.ecosystem).filter((id) => verified.has(id)),
    checks: uniquifyLabels(kept),
    // Only the CAP truncates. A group dropped for verifying nothing was never a suggestion to
    // begin with, so counting it here would report a truncation that discarded no check.
    truncated: ordered.length > capped.length,
    ...(installs.length ? { dependencyInstall: installs.join(' && ') } : {}),
  }
}

/**
 * Make the labels unique, which the write contract REQUIRES — two ecosystems both
 * proposing `test` would otherwise produce a suggestion the operator cannot save, with a
 * validation error that names neither offender. Disambiguates with the ecosystem first
 * (`test` / `test (go)`), which is the information a reader actually wants, and falls back
 * to an ordinal only if that still collides.
 */
function uniquifyLabels(
  checks: (DetectedCheck & { ecosystem: ValidationEcosystem })[],
): { label: string; command: string }[] {
  const taken = new Set<string>()
  return checks.map((c) => {
    const candidates = [c.label, `${c.label} (${c.ecosystem})`]
    let label = candidates.find((l) => !taken.has(l))
    for (let n = 2; label === undefined; n += 1) {
      const numbered = `${c.label} (${c.ecosystem} ${n})`
      if (!taken.has(numbered)) label = numbered
    }
    taken.add(label)
    // The write contract caps a label at 80 chars; every label built here is far shorter,
    // but clamp anyway so a future long label degrades instead of failing the save.
    return { label: label.slice(0, 80), command: c.command }
  })
}
