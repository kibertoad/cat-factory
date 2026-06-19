import type {
  RunnerDispatchKind,
  RunnerJobView,
  RunnerPoolManifest,
  RunnerPoolProvider,
  RunnerTransport,
  SecretResolver,
} from '@cat-factory/kernel'

// Adapts the stateless, manifest-interpreting HttpRunnerPoolProvider to the
// per-job RunnerTransport the container executor drives, binding one workspace's
// resolved manifest + secret resolver. One instance per (workspace) dispatch/poll
// resolution; the underlying provider (and its OAuth cache) is shared.

export class RunnerPoolTransport implements RunnerTransport {
  constructor(
    private readonly provider: RunnerPoolProvider,
    private readonly manifest: RunnerPoolManifest,
    private readonly resolveSecret: SecretResolver,
  ) {}

  dispatch(
    jobId: string,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'run',
  ): Promise<void> {
    // Self-hosted pools implement the coding-run protocol only; blueprint mapping
    // runs exclusively on the Cloudflare container backend.
    if (kind !== 'run') {
      throw new Error(`Self-hosted runner pools do not support '${kind}' jobs`)
    }
    return this.provider.dispatch({
      manifest: this.manifest,
      jobId,
      spec,
      resolveSecret: this.resolveSecret,
    })
  }

  poll(jobId: string): Promise<RunnerJobView> {
    return this.provider.poll({ manifest: this.manifest, jobId, resolveSecret: this.resolveSecret })
  }

  release(jobId: string): Promise<void> {
    return this.provider.release({
      manifest: this.manifest,
      jobId,
      resolveSecret: this.resolveSecret,
    })
  }
}
