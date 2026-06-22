import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobView,
  RunnerPoolManifest,
  RunnerPoolProvider,
  RunnerTransport,
  SecretResolver,
} from '@cat-factory/kernel'

// Dispatch kinds a self-hosted pool's harness can serve. The pool runs the same
// executor-harness image as the Cloudflare backend, so it serves the coding run and
// the Tester/Fixer loop; the remaining kinds (blueprint/spec/merge/…) stay on the
// Cloudflare backend until a pool opts into them.
const POOL_SUPPORTED_KINDS = new Set<RunnerDispatchKind>(['run', 'test', 'fix-tests'])

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
    // A pool serves the coding run plus the Tester/Fixer loop; the remaining kinds
    // run exclusively on the Cloudflare container backend for now.
    if (!POOL_SUPPORTED_KINDS.has(kind)) {
      throw new Error(`Self-hosted runner pools do not support '${kind}' jobs`)
    }
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
