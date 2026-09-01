import type { AgentRunContext, RunnerDispatchOptions } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { resolveInstanceTypeId } from '@cat-factory/contracts'
import { imageVariantFor } from './containerJobAddressing.js'
import { dispatchEnvironments } from './prompts.js'

// What a container dispatch tells its transport ABOUT the job, beside the job body.
//
// Everything here is a directive to the BACKEND rather than a fact the agent reads: which instance
// to start it on, which executor image, and which environments its container has to be able to
// reach. A transport that has nothing to do with one ignores it, which is why they travel together
// and are all optional.
//
// Its own module because the alternative is the executor growing a fourth, fifth and sixth
// per-directive derivation inline, each with the paragraph explaining which backend acts on it.

/**
 * Assemble the dispatch directives for `context`, or undefined when there are none.
 *
 * Undefined rather than `{}` so a transport's `options?.x` reads the same for "this deployment
 * pins nothing" and "this call passed no options at all", which several already rely on.
 */
export function buildDispatchOptions(
  context: AgentRunContext,
  registry: AgentKindRegistry,
): RunnerDispatchOptions | undefined {
  // Per-service provisioning hints: the cloud provider the service runs on and the abstract
  // instance size, resolved to the target's concrete instance-type id. Cloudflare maps the id to a
  // Container instance type; a self-hosted pool forwards it (with the provider) and provisions
  // itself. Absent when the service pins neither, and the transport keeps its default.
  const provider = context.service?.cloudProvider
  const size = context.service?.instanceSize
  const image = imageVariantFor(context.agentKind, registry)
  // The environments this job is being handed, so a transport whose containers cannot reach one as
  // written can do something about it before it starts one. See `dispatchEnvironments`.
  const environments = dispatchEnvironments(context)
  if (!provider && !size && !image && environments.length === 0) return undefined
  return {
    ...(provider || size ? { instanceTypeId: resolveInstanceTypeId(provider, size) } : {}),
    ...(provider ? { provider } : {}),
    // Forward the abstract size too, so the local Docker/Podman backend can size the per-job
    // container (`--memory`/`--cpus`) without decoding the cloud id.
    ...(size ? { instanceSize: size } : {}),
    ...(image ? { image } : {}),
    ...(environments.length ? { environments } : {}),
  }
}
