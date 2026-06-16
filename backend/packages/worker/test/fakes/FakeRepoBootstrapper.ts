import type {
  BootstrapRepoOutcome,
  BootstrapRepoRequest,
  RepoBootstrapper,
} from '@cat-factory/core'

/**
 * Deterministic RepoBootstrapper for integration tests: records each request and
 * returns a canned outcome (or throws when `failWith` is set), so the bootstrap
 * orchestration can be exercised without GitHub or a real container.
 */
export class FakeRepoBootstrapper implements RepoBootstrapper {
  readonly calls: BootstrapRepoRequest[] = []
  /** When set, `bootstrap` throws with this message to exercise the failure path. */
  failWith: string | null = null
  /** Whether the workspace reports as connected (the pre-flight check); on by default. */
  connected = true

  async isWorkspaceConnected(): Promise<boolean> {
    return this.connected
  }

  async bootstrap(request: BootstrapRepoRequest): Promise<BootstrapRepoOutcome> {
    this.calls.push(request)
    if (this.failWith) throw new Error(this.failWith)
    return {
      repoUrl: `https://github.com/acme/${request.target.name}`,
      owner: 'acme',
      name: request.target.name,
      defaultBranch: 'main',
    }
  }
}
