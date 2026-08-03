import type { ApiContractDocument } from '@cat-factory/contracts'
import type {
  BinaryGeneratorRegistry,
  BinaryGeneratorView,
} from '../domain/binary-generator-registry.js'

// Where the deployment's GENERATIVE BINARY INTEGRATIONS are READ from — the exact sibling of
// `foundational-builtins.ts`, and it exists for the exact same reason: a deployment is not
// always ONE process.
//
// In a standalone deployment the set is the in-process `BinaryGeneratorRegistry` the composition
// root news, and this port is a thin wrapper over it ({@link registryBinaryGeneratorSource}).
//
// In MOTHERSHIP mode (docs/initiatives/mothership-mode.md) a deployment is two processes: the
// hosted mothership serves the pipeline builder that SELECTS an integration, and a local node
// with no main database resolves that selection for the runs it dispatches. The registry-only
// shape forced a deployment to register its integrations on BOTH entry points, and the two
// copies were equal only for as long as both imported the same package at the same commit — the
// same skew the estate had, on a node one build behind, which is the NORMAL state of a
// mothership deployment.
//
// The failure is LOUDER than the estate's and worse targeted. Registered on the mothership
// alone, the builder offers `retro-diffusion` from the product's own picker and every run of
// that step is then refused by `RunAdmission` with `unknown_generator` — for an id the product
// just offered. The message names the step's configuration; the step's configuration is
// correct, and the half-wired deployment is invisible in it, so an operator's first move is to
// go edit a step with nothing wrong with it. Registered on the node alone, runs work and the
// step is unreachable through the builder.
//
// So a deployment's integrations are org state and the mothership owns them, like every other
// org fact a mothership-mode node reads remotely: the node resolves this port over
// `GET /internal/binary-generators`, and its own in-process registry is not consulted.
//
// A read failure THROWS rather than answering with an empty set. "The mothership is
// unreachable" and "this deployment registers no integrations" are the same value and opposite
// facts, and here the second one is ADMISSION policy — answering it for the first would refuse
// a correctly configured step with `unknown_generator` during a transient outage, which is the
// misattribution above with a different cause. Each caller states the outage in its own
// vocabulary instead: admission refuses with `binary_generators_unavailable` (503-shaped and
// retryable, deliberately not `binary_output_generator_invalid`), the brief renderer keeps its
// best-effort disposition and injects nothing (which the trait guidance already defines as "do
// not attempt any upload; report it"), and the builder's picker says it could not be read
// rather than showing an empty list.

/**
 * The deployment's generative binary integrations, as the engine and the HTTP layer read them.
 *
 * Deliberately just the two projections {@link BinaryGeneratorRegistry} already exposes —
 * body-free views for admission, the picker and the run context; full documents for the
 * dispatch brief — so a remote implementation is a transport and never a second view of the
 * data. Both are async because one implementation crosses a network; an in-process source
 * resolves immediately.
 */
export interface BinaryGeneratorSource {
  /** Every registered integration, projected for the engine (no document bodies). */
  views(): Promise<BinaryGeneratorView[]>
  /**
   * The FULL contract documents of the named integrations, indexed by id. An id the deployment
   * does not register is simply absent from the map.
   *
   * Batched rather than per-id because one implementation crosses a network: a step's whole
   * selection is in hand at once, and a per-id read in a loop over it is the N+1 every other
   * remote read here already avoids.
   */
  documentsFor(ids: string[]): Promise<Map<string, ApiContractDocument[]>>
}

/**
 * The in-process source: a deployment's own registry, read directly. The default on every
 * facade that is not a mothership-mode node.
 */
export function registryBinaryGeneratorSource(
  registry: BinaryGeneratorRegistry,
): BinaryGeneratorSource {
  return {
    views: async () => registry.views(),
    documentsFor: async (ids) => new Map(ids.map((id) => [id, registry.documentsFor(id)] as const)),
  }
}
