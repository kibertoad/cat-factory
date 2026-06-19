import type { BlueprintService, BlueprintSource } from '../domain/types.js'

// RepoScanner port: performs the side-effecting half of a "scan repository" run —
// read the actual codebase (clone / tree) and decompose it into the canonical
// service → modules blueprint, anchored to real file paths. Kept as a
// port so the core orchestration (BoardScanService) stays free of GitHub/container
// infrastructure; the worker supplies a ContainerRepoScanner, and tests a fake.

export interface ScanRepoRequest {
  /** Workspace the scan belongs to (resolves the GitHub installation to use). */
  workspaceId: string
  /** The repository to scan. */
  repo: { owner: string; name: string }
  /** Extra guidance for the scanner (focus areas, naming, granularity). */
  instructions: string
}

export interface ScannedBlueprint {
  /** Whether an LLM produced the decomposition, or the deterministic heuristic. */
  source: BlueprintSource
  /** The repository decomposed into one service frame with its modules. */
  service: BlueprintService
}

export interface RepoScanner {
  scan(request: ScanRepoRequest): Promise<ScannedBlueprint>
}
