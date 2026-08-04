// The provisioning detectors' shared CONTRACT: the narrow repo reader every one of them reads
// through, the read budget they share, the deployment-level convention EXTENSIONS they all
// honour, and the one additive merge that layers those extras onto a built-in candidate list.
//
// Split out of `provision-detect.logic.ts` so the compose half (`provision-detect.compose.ts`)
// and the Kubernetes half can each import it without importing the other's detector. `logic.ts`
// re-exports the public members, so every existing importer is unaffected.

/**
 * The narrow slice of {@link RepoFiles} the detector needs — a {@link RepoFiles} satisfies it
 * structurally, and a test supplies an in-memory fake. A MISSING path yields `null` / `[]`, so the
 * heuristics degrade gracefully on partial repos. A genuine read fault (auth/permission revoked,
 * rate limit, transport error) may THROW — the real GitHub/GitLab reader throws on any non-404
 * status. The {@link BudgetedRepoScanner} tolerates that (records it, keeps scanning best-effort)
 * so a transient fault mid-scan can't lose an otherwise-good result; see its `readFault`.
 */
export interface ProvisioningRepoReader {
  getFile(path: string, gitRef?: string): Promise<{ content: string } | null>
  listDirectory(
    path: string,
    gitRef?: string,
  ): Promise<{ name: string; type: string; path: string }[]>
}

/**
 * Deployment-level EXTENSIONS to the built-in detection conventions, so an org whose repos follow
 * house conventions the defaults don't name (a compose file called `stack.yml`, seeds under
 * `ops/seeds/`, …) can broaden detection WITHOUT a code edit — set on the deployment config and
 * threaded into the detectors as `DetectProvisioningOptions.conventions`. Every field is
 * ADDITIVE: the built-in list always wins where it and an extra overlap, and the canonical compose
 * names still take priority (extras are appended lowest-priority), so widening the search can only
 * find MORE, never change what a default-shaped repo already resolves to. Absent ⇒ exactly the
 * built-in behaviour.
 */
export interface DetectionConventions {
  /** Extra compose file base names to recognize, appended AFTER the canonical set (lowest priority). */
  composeFiles?: string[]
  /** Extra directories (repo-relative) to search for a compose file, beyond `deploy`/`docker`/…. */
  composeDirs?: string[]
  /** Extra directories a SQL seed dump may live under, beyond `deployment`/`seed`/`db`/…. */
  seedDirs?: string[]
  /** Extra directories an env/config template may sit in, beyond the compose dir + `config`/`env`/…. */
  envTemplateDirs?: string[]
  /**
   * Extra top-level directories to treat as shared DEPLOY-MANIFEST roots for the monorepo
   * per-service slice search, beyond the built-in `deploy`/`deployment`/`k8s`/`manifests`/… set
   * (appended lowest-priority). For an org whose manifests live under a house-named root the
   * defaults don't cover (e.g. `platform/`, `release/`).
   */
  manifestDirs?: string[]
  /**
   * House-layout path TEMPLATES that map a service DIRECTLY to its manifests, tried BEFORE the
   * heuristic search — the deterministic escape hatch for a layout the heuristics can't infer (or
   * that you simply want pinned). Each template may contain two placeholders:
   *
   * - `{service}` — the service directory's basename (e.g. `backend-acme` for a service whose
   *   `directory` is `services/team-alpha/backend-acme`).
   * - `{env}` — expanded across the known ephemeral-environment names (`prenv`, `preview`, `pr`,
   *   `dev`, `staging`, …); the first template whose expansion resolves to real manifests wins.
   *
   * E.g. `["deployment/k8s/overlays/{env}/{service}", "deployment/k8s/base/services/{service}"]`.
   * A template that resolves is used verbatim (highest confidence); if none resolve the heuristic
   * search runs as normal, so a template can only ADD determinism, never suppress detection.
   */
  serviceManifestPaths?: string[]
}

// Bounds the total reads so a pathological repo can't fan out unboundedly. Raised from 80 because
// the candidate lists grew (more k8s dirs, compose dirs, shared-deploy roots) and manifest-root
// collection no longer short-circuits on the first hit — still tiny versus a real API. Reads are
// intentionally SEQUENTIAL (not batched/parallel): the budget short-circuit and the "first present
// name/dir wins" ordering both depend on deterministic, in-order accounting. In practice a real
// repo resolves in a handful of reads well before the cap; the cap only bites on decoy-heavy repos,
// where truncation is surfaced as a note (see `BudgetedRepoScanner.exhausted`).
export const READ_BUDGET = 200

/** Append `extras` after `base`, dropping any already present in `base` (base wins / stays first). */
export function withExtras(base: readonly string[], extras: string[] | undefined): string[] {
  if (!extras || extras.length === 0) return [...base]
  const seen = new Set(base)
  const out = [...base]
  for (const raw of extras) {
    const value = raw.trim()
    if (value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}
