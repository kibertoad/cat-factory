import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobView,
  RunnerPoolManifest,
  RunnerPoolProvider,
  RunnerTransport,
  SecretResolver,
} from '@cat-factory/kernel'

// Dispatch kinds a self-hosted pool's harness can serve. The pool runs the SAME
// executor-harness image as the Cloudflare backend, so it serves EVERY harness route —
// the coding run, read-only exploration, the Tester/Fixer loop, repo bootstrap, the
// blueprint mapper, the spec writer, the merge assessor and the CI / conflict fixers.
// None of these need a Cloudflare-specific primitive (they are all plain harness HTTP
// routes), so the pool serves them exactly like the local Docker transport does. The
// guard is kept (rather than removed) so a future genuinely Cloudflare-only kind is
// rejected by default until it is explicitly added here.
const POOL_SUPPORTED_KINDS = new Set<RunnerDispatchKind>([
  'run',
  'blueprint',
  'spec',
  'explore',
  'bootstrap',
  'ci-fix',
  'resolve-conflicts',
  'merge',
  'test',
  'fix-tests',
])

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
    // A pool runs the full executor-harness image, so it serves every harness route;
    // the guard only trips on a (hypothetical) future Cloudflare-only kind.
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
