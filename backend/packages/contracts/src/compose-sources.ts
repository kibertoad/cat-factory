import * as v from 'valibot'
import { vcsProviderSchema } from './routes/auth.js'

// ---------------------------------------------------------------------------
// COMPOSE SOURCES — where ONE `-f` compose layer's TEXT comes from.
//
// Both a service's STACK RECIPE (`stackRecipeSchema.composeFiles`) and a SHARED STACK
// (`sharedStackSchema.composeFiles`) name an ORDERED list of compose layers. Until now a
// layer could only be a path inside the ONE repo the run/stack already clones, which made
// two shapes unexpressible:
//
//   - a DEFINITION supplied directly (a deployment declares its infra stack in code, or an
//     operator pastes a compose document) — there is no repo to read it from at all;
//   - a REFERENCE into a DIFFERENT repo (a central `acme/infra` repo carrying the compose
//     files every service's preview attaches to), which the simple single-file path already
//     supported via `composeRepo`/`composeRef` but the layered recipe path did not.
//
// So a layer is a {@link ComposeSource}: `path` (in the primary repo — the checkout a run
// clones, or a shared stack's own `cloneUrl`), `inline` (the document itself), or `repo`
// (a path in another `owner/name` read checkout-free through the workspace's VCS connection).
// A bare STRING stays a first-class shorthand for `{ kind: 'path' }` — it is what the
// deterministic detector emits and what the panel edits, so the common case reads as a plain
// list of filenames. Normalization + the materialized-path rules are pure kernel logic
// (`domain/compose-sources.ts`); resolution is `@cat-factory/integrations`'
// `modules/compose/compose-sources.ts`, shared by the compose provider and the shared-stack
// bring-up. See docs/initiatives/stack-recipes-and-shared-stacks.md.
// ---------------------------------------------------------------------------

/** A repo-relative compose path (bounded, trimmed). The runtime applies the checkout-escape guard. */
const composePathString = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500))

/** A branch / tag / sha another repo's compose layer is read at. */
const composeRefString = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/** `owner/name` of another repo carrying a compose layer. */
const composeRepoSlug = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/repo"'),
)

/**
 * An inline compose DOCUMENT. Capped well below any store's row budget while still admitting a
 * genuinely large multi-service stack — the acme-shared-services pilot's ~17-service compose file
 * is ~12 KB, so 256 KB leaves an order of magnitude of headroom. A document over the cap is
 * REFUSED rather than truncated: half a compose file parses as valid YAML describing the wrong
 * stack, which would fail as a mysterious missing-service error at `up` time.
 */
const composeInlineText = v.pipe(v.string(), v.minLength(1), v.maxLength(262_144))

/**
 * Where one ordered `-f` compose layer's text comes from:
 *
 * - `path`   — a path in the PRIMARY repo (the run's checkout for a recipe, the stack's own
 *   `cloneUrl` checkout for a shared stack). The layer is read and used where it already sits,
 *   so its sibling files (`env_file`s, build contexts, bind mounts) resolve as authored.
 * - `inline` — the compose document supplied DIRECTLY. Materialized into the working tree before
 *   `up` at `path` when given, else at a deterministic generated path. A stack made only of
 *   inline layers needs NO repo at all.
 * - `repo`   — a path in ANOTHER `owner/name`, read checkout-free through the workspace's VCS
 *   connection (never cloned) and materialized into the working tree beside the other layers.
 *
 * A `repo` / `inline` layer's own relative references resolve against the compose PROJECT
 * DIRECTORY like every other layer's (docker compose resolves relatives against
 * `--project-directory`, not against each file's location), so a foreign layer that names a build
 * context or bind mount is pointing into the PRIMARY checkout — the same host-escape guard judges
 * it. Reach for `repo`/`inline` for layers that pull images and wire networks; a layer that builds
 * from source belongs in the repo whose source it builds.
 */
export const composeSourceSchema = v.variant('kind', [
  v.object({
    kind: v.literal('path'),
    /** Path within the primary repo. */
    path: composePathString,
  }),
  v.object({
    kind: v.literal('inline'),
    /** The compose document itself. */
    content: composeInlineText,
    /**
     * Where the document is materialized in the working tree; absent ⇒ a generated path under the
     * project directory. Name it when the layer must sit somewhere specific (a sibling file
     * references it), leave it off otherwise.
     */
    path: v.optional(composePathString),
  }),
  v.object({
    kind: v.literal('repo'),
    /** `owner/name` of the repo carrying the layer. */
    repo: composeRepoSlug,
    /** Path within THAT repo. */
    path: composePathString,
    /** Branch / tag / sha; absent ⇒ that repo's default branch. */
    ref: v.optional(composeRefString),
    /** VCS provider; absent ⇒ the workspace's connected provider. */
    provider: v.optional(vcsProviderSchema),
  }),
])
export type ComposeSource = v.InferOutput<typeof composeSourceSchema>
export type ComposeSourceKind = ComposeSource['kind']

/**
 * One ordered compose layer: a bare repo-relative PATH (the shorthand — a plain list of filenames
 * is the common case, and what the deterministic detector emits) or an explicit
 * {@link composeSourceSchema}. Normalize with kernel's `normalizeComposeFileRef` before consuming.
 */
export const composeFileRefSchema = v.union([composePathString, composeSourceSchema])
export type ComposeFileRef = v.InferOutput<typeof composeFileRefSchema>

// The two SHAPE-level helpers live here rather than in kernel because the SPA needs them too (it
// renders a stack's layer list and must not mangle a layer it can't edit), and the SPA depends on
// contracts alone. Kernel re-exports both beside its backend-only PLACEMENT rules, so a backend
// call site still resolves the whole vocabulary from one import.

/** Lift the bare-path shorthand into the explicit source shape. */
export function normalizeComposeFileRef(ref: ComposeFileRef): ComposeSource {
  return typeof ref === 'string' ? { kind: 'path', path: ref } : ref
}

/** Normalize a whole ordered layer list. */
export function normalizeComposeFileRefs(refs: readonly ComposeFileRef[]): ComposeSource[] {
  return refs.map(normalizeComposeFileRef)
}

/** A short human label for a layer — a provisioning-log step name, an error, a read-only chip. */
export function describeComposeSource(source: ComposeSource): string {
  switch (source.kind) {
    case 'path':
      return source.path
    case 'inline':
      return source.path ? `inline (${source.path})` : 'inline'
    case 'repo':
      return `${source.repo}${source.ref ? `@${source.ref}` : ''}:${source.path}`
  }
}
