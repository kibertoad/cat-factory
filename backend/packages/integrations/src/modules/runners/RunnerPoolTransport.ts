import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
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
//
// Runtime-neutral: both the Cloudflare Worker and the Node service resolve this
// transport for a workspace whose self-hosted runner pool is registered.

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
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    // A pool runs the SAME executor-harness image as the Cloudflare backend, so it
    // serves every harness route. Runtime parity is the default and assumed (the "keep
    // the runtimes symmetric" guideline): there is no opt-in allow-list to gate kinds,
    // so a new harness kind dispatches to a pool automatically, exactly as it does to a
    // Cloudflare container — never silently diverging.
    //
    // Forward the harness route kind and the resolved provisioning hints (the
    // instance-type id + the cloud provider) in the dispatch spec so a pool that
    // provisions on its own cloud can route to the right endpoint and size the runner.
    return this.provider.dispatch({
      manifest: this.manifest,
      jobId,
      spec: {
        ...spec,
        kind,
        ...(options?.instanceTypeId ? { instanceType: options.instanceTypeId } : {}),
        ...(options?.provider ? { cloudProvider: options.provider } : {}),
      },
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
