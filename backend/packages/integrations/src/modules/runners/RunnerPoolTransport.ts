import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerPoolManifest,
  RunnerPoolProvider,
  RunnerTransport,
  SecretResolver,
} from '@cat-factory/kernel'

// Adapts the stateless, manifest-interpreting HttpRunnerPoolProvider to the
// RunnerTransport the container executor drives, binding one workspace's resolved
// manifest + secret resolver. One instance per (workspace) dispatch/poll resolution;
// the underlying provider (and its OAuth cache) is shared.
//
// A pool is a PER-JOB backend — it has no per-run container to share across steps —
// so it keys on the per-step `ref.jobId`; each step is an independent pool job, which
// is exactly what keeps sibling steps from colliding here too. `ref.runId` is unused
// (there is no run-scoped resource to address), and `release` cancels the run's
// in-flight job by its id.
//
// Runtime-neutral: both the Cloudflare Worker and the Node service resolve this
// transport for a workspace whose self-hosted runner pool is registered.
//
// Harness inbound auth (HARNESS_SHARED_SECRET / the `x-harness-secret` header) is NOT
// sent here, unlike the Cloudflare and local Docker transports. Those call the harness
// HTTP server directly, so they issue the header; a pool instead hands the job to the
// workspace's OWN control plane, which is what reaches the harness. The harness secret
// is therefore configured pool-side by the operator (it provisions the runner env and
// its dispatch). This is a genuine architectural difference, not a facade-parity gap:
// the pool is BYO infra inside the workspace's trust domain.

export class RunnerPoolTransport implements RunnerTransport {
  constructor(
    private readonly provider: RunnerPoolProvider,
    private readonly manifest: RunnerPoolManifest,
    private readonly resolveSecret: SecretResolver,
  ) {}

  dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    const jobId = ref.jobId
    // A pool runs the SAME executor-harness image as the Cloudflare backend, so it
    // serves every harness route. Runtime parity is the default and assumed (the "keep
    // the runtimes symmetric" guideline): there is no opt-in allow-list to gate kinds,
    // so a new harness kind dispatches to a pool automatically, exactly as it does to a
    // Cloudflare container, never silently diverging.
    //
    // Forward the harness route kind and the resolved provisioning hints (the
    // instance-type id, the cloud provider, and the image variant) in the dispatch spec so a
    // pool that provisions on its own cloud can route to the right endpoint, size the runner,
    // and pull the right image — `image: 'deploy'` selects the deploy-harness image (real
    // kubectl/kustomize/helm) for a container-backed Kubernetes provision, `ui` the heavier
    // Playwright image, else the default executor image.
    return this.provider.dispatch({
      manifest: this.manifest,
      jobId,
      spec: {
        ...spec,
        kind,
        ...(options?.instanceTypeId ? { instanceType: options.instanceTypeId } : {}),
        ...(options?.provider ? { cloudProvider: options.provider } : {}),
        ...(options?.image ? { image: options.image } : {}),
      },
      resolveSecret: this.resolveSecret,
    })
  }

  poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    return this.provider.poll({
      manifest: this.manifest,
      jobId: ref.jobId,
      resolveSecret: this.resolveSecret,
    })
  }

  release(ref: RunnerJobRef): Promise<void> {
    return this.provider.release({
      manifest: this.manifest,
      jobId: ref.jobId,
      resolveSecret: this.resolveSecret,
    })
  }
}
