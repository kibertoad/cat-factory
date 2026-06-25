import type {
  SandboxExperiment,
  SandboxExperimentStatus,
  SandboxFixture,
  SandboxGrade,
  SandboxPromptVersion,
  SandboxRun,
  SandboxRunStatus,
} from '../domain/types.js'

// Persistence ports for the Sandbox (the parallel prompt/model testing surface).
// Each runtime implements these against its store (Cloudflare D1, Node Postgres);
// tests/conformance supply in-memory fakes. Everything is workspace-scoped and the
// feature is opt-in, so a deployment that wires no sandbox module simply has no
// repositories and the controller answers 503.

/** Stored candidate prompt-version lineages (baselines are NOT stored — see contracts). */
export interface SandboxPromptVersionRepository {
  get(workspaceId: string, id: string): Promise<SandboxPromptVersion | null>
  /** All non-archived candidate versions for a workspace, newest first. */
  list(workspaceId: string): Promise<SandboxPromptVersion[]>
  /** All non-archived candidate versions for one agent kind. */
  listByKind(workspaceId: string, agentKind: string): Promise<SandboxPromptVersion[]>
  upsert(workspaceId: string, version: SandboxPromptVersion): Promise<void>
  /** Soft-archive a version (hidden from the default listing). */
  archive(workspaceId: string, id: string, at: number): Promise<void>
}

export interface SandboxFixtureRepository {
  get(workspaceId: string, id: string): Promise<SandboxFixture | null>
  list(workspaceId: string): Promise<SandboxFixture[]>
  upsert(workspaceId: string, fixture: SandboxFixture): Promise<void>
  remove(workspaceId: string, id: string): Promise<void>
}

export interface SandboxExperimentRepository {
  get(workspaceId: string, id: string): Promise<SandboxExperiment | null>
  list(workspaceId: string): Promise<SandboxExperiment[]>
  upsert(workspaceId: string, experiment: SandboxExperiment): Promise<void>
  setStatus(workspaceId: string, id: string, status: SandboxExperimentStatus): Promise<void>
}

export interface SandboxRunRepository {
  get(workspaceId: string, id: string): Promise<SandboxRun | null>
  /** All cells of an experiment (the results grid). */
  listByExperiment(workspaceId: string, experimentId: string): Promise<SandboxRun[]>
  /** Queued cells of an experiment, oldest first (for the durable fan-out driver). */
  listQueued(workspaceId: string, experimentId: string): Promise<SandboxRun[]>
  upsert(workspaceId: string, run: SandboxRun): Promise<void>
  setStatus(workspaceId: string, id: string, status: SandboxRunStatus): Promise<void>
  /** Drop every cell of an experiment (a relaunch clears the prior grid first). */
  removeByExperiment(workspaceId: string, experimentId: string): Promise<void>
}

export interface SandboxGradeRepository {
  getByRun(workspaceId: string, runId: string): Promise<SandboxGrade | null>
  listByExperiment(workspaceId: string, experimentId: string): Promise<SandboxGrade[]>
  upsert(workspaceId: string, grade: SandboxGrade): Promise<void>
  /** Drop every grade of an experiment's cells (a relaunch clears the prior grid first). */
  removeByExperiment(workspaceId: string, experimentId: string): Promise<void>
}
