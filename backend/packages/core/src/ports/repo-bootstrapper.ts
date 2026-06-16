// RepoBootstrapper port: performs the side-effecting half of a "bootstrap repo"
// run — create the new GitHub repository and run a bootstrapper agent inside a
// sandbox container that clones the reference architecture, adapts it per the
// instructions, and pushes the result. Kept as a port so the core orchestration
// (BootstrapService) stays free of GitHub/container infrastructure; the worker
// supplies a ContainerRepoBootstrapper, and tests supply a fake.

export interface BootstrapRepoRequest {
  /** Workspace the run belongs to (resolves the GitHub installation to use). */
  workspaceId: string
  /** Id of the bootstrap job this run records into (for traceability). */
  jobId: string
  /** The base repository to clone from, or undefined to scaffold from scratch. */
  referenceRepo?: { owner: string; name: string }
  /** The repository to create and bootstrap into. */
  target: { name: string; description: string; private: boolean }
  /** Effective bootstrapper instructions (reference defaults + per-run extras). */
  instructions: string
}

export interface BootstrapRepoOutcome {
  /** Web URL of the created repository. */
  repoUrl: string
  /** Owner the repo was created under. */
  owner: string
  /** Name of the created repository. */
  name: string
  /** Default branch the bootstrapped contents were pushed to. */
  defaultBranch: string
}

export interface RepoBootstrapper {
  /**
   * Whether the workspace is connected to GitHub (an active App installation
   * exists). Checked before a run starts so an unconnected workspace fails fast
   * with a clear error instead of recording a job that immediately fails.
   */
  isWorkspaceConnected(workspaceId: string): Promise<boolean>
  bootstrap(request: BootstrapRepoRequest): Promise<BootstrapRepoOutcome>
}
