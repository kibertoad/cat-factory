import * as v from 'valibot'
import { documentOriginSchema } from './documents.js'
import { frameRepoTypeSchema } from './primitives.js'
import { publicTaskDocumentSchema } from './public-api.js'

// ---------------------------------------------------------------------------
// Public-API wire contracts for PROVISIONING the board a headless deployment drives, and for
// the two task relationships that outlive a single create call.
//
// `/api/v1` could list services and create a task under one, and nothing could create a service,
// link a repository to one, express an ordering between two tasks, or change a task's attached
// documents after it was filed. That is the same class of gap the outbound webhook and headless key
// provisioning each closed for themselves: a deployment whose operator is headless could drive
// every part of this API except the one act it had to open a browser for.
//
// Three rules shape everything here, and each is a boundary rather than a preference:
//
//  1. **No board COORDINATES.** Positions, sizes and reparenting are ergonomics for a human looking
//     at a canvas. Publishing a coordinate system into a surface that is frozen forever buys an
//     integration nothing and costs the board its freedom to change how it lays itself out, so a
//     service created here is laid out by the platform exactly as the app's own import button
//     lays one out.
//  2. **The REPO LINK is the load-bearing half.** A service frame with no linked repository cannot
//     run anything (`resolveRepoTarget` throws by design, deliberately with no first-repo
//     fallback), so an endpoint that created frames and could not link them would ship output
//     that is unusable by the very surface that made it.
//  3. **One rule at every door.** Every write here delegates to the SAME service method the SPA's
//     own controller calls, so an invariant cannot differ by surface.
// ---------------------------------------------------------------------------

/**
 * The repository a new service frame is backed by.
 *
 * `repoId` is the provider's own id for the repo, as `GET /api/v1/repos` serves it: the neutral
 * name for what the internal projection calls `githubId`. It is deliberately not an `owner/name`
 * pair: a repo can be renamed or transferred without changing its id, and a caller that held a name
 * would silently create a service against a different repository after such a move.
 */
export const publicServiceRepoSchema = v.object({
  /** The repo's provider id, from `GET /api/v1/repos`. */
  repoId: v.number(),
  /**
   * For a MONOREPO, the subdirectory (relative to the repo root) this service lives in, e.g.
   * `packages/api`. Required when the repo is a monorepo and refused for a whole-repo service,
   * because it is what scopes each agent's working directory: a monorepo backs one service per
   * subdirectory, and two services claiming the same one would fight over the same subtree.
   */
  directory: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /**
   * Whether the repository hosts SEVERAL services. Sent with the create rather than as a separate
   * up-front write; when supplied it is persisted on the repo, so the flag a later create reads is
   * the one this call set. Omitted ⇒ whatever the repo already says.
   */
  monorepo: v.optional(v.boolean()),
})
export type PublicServiceRepo = v.InferOutput<typeof publicServiceRepoSchema>

/**
 * Create a board service (a service frame), optionally backed by a repository.
 *
 * Without `repo` the frame is a structural placeholder: it can hold tasks, and a run started on one
 * of them is REFUSED, because execution resolves a task's repository by walking up to the enclosing
 * service frame and there is nothing there. That is a legitimate intermediate state (a caller
 * mapping out a board before its repositories exist) and it is why the field is optional rather
 * than why it should usually be omitted.
 *
 * There is deliberately no `position`: see the note at the top of this file.
 */
export const createPublicServiceSchema = v.object({
  /**
   * The service's name. Optional, because a repo-backed service is named after the repository (or,
   * for a monorepo service, after its subdirectory) exactly as the app's import does, and a caller
   * that has no better name should get that one rather than being made to invent it.
   */
  title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  /** What the service is, for the agents that read it as context. Defaults to a generated line. */
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  /**
   * The service's architectural role. Omitted ⇒ `service`.
   *
   * Narrower than the board's own block types on purpose: this is the set a REPOSITORY can back,
   * which is the only kind of frame this endpoint creates. A `database` or `queue` frame documents
   * infrastructure for the agents to read and runs nothing, so nothing here would create one.
   */
  type: v.optional(frameRepoTypeSchema),
  /** The repository backing the service. Omitted ⇒ an unlinked frame (see above). */
  repo: v.optional(publicServiceRepoSchema),
})
export type CreatePublicServiceInput = v.InferOutput<typeof createPublicServiceSchema>

/**
 * A repository this workspace can back a service with, as `GET /api/v1/repos` lists it.
 *
 * The discovery half of {@link publicServiceRepoSchema}, and it is why service creation is usable
 * headlessly at all: the create takes a `repoId`, and until this existed the only way to learn one
 * was to open the app. Deliberately a small projection (enough to recognise a repository and pass
 * it back), not a mirror of the internal projection row, which carries installation ids and
 * sync bookkeeping that are this platform's business rather than a caller's.
 */
export const publicRepoSchema = v.object({
  /** The provider's id for the repo: the value to pass as `repo.repoId`. */
  repoId: v.number(),
  /** Which provider it lives on (`github` / `gitlab`). */
  provider: v.string(),
  owner: v.string(),
  name: v.string(),
  /**
   * The branch a run's work is based on and merged into, or EMPTY when the projection has not
   * recorded one yet (a repository connected moments ago, before its first sync). Empty rather
   * than null because there is nothing here that could invent a default, and a caller reading it
   * to name a base needs to see that it has to ask the provider rather than assume `main`.
   */
  defaultBranch: v.string(),
  /** Whether the repository is private on its provider. */
  private: v.boolean(),
  /** Whether the repo is flagged as hosting several services (see `repo.monorepo`). */
  monorepo: v.boolean(),
  /**
   * The service this repository already backs ON THIS BOARD, or null.
   *
   * Present because a whole-repo repository backs at most ONE service, so a caller choosing one to
   * create against needs to know which choices are already spent, and, more usefully, because a
   * caller re-running its provisioning finds the service it created last time here rather than
   * discovering it through a `409`. A monorepo answers null even when its subdirectories back
   * services, since it can back more.
   *
   * Null and {@link linkedElsewhere} together are the honest answer when the service is homed on
   * another board of the account: read the flag before treating null as "available".
   */
  serviceId: v.nullable(v.string()),
  /**
   * True when this repository already backs a whole-repo service homed on ANOTHER board of the
   * account, so `POST /api/v1/services` will refuse it (`reason: repo_service_homed_elsewhere`).
   *
   * A service is account-owned and a board can MOUNT one homed elsewhere, but every read on this
   * API is scoped to the calling key's own workspace, so a frame homed on another board has no id
   * this surface could hand back: it would not appear in `GET /api/v1/services` and
   * `POST /api/v1/services/{serviceId}/tasks` would 404 on it. Hence a flag rather than a second
   * id field — this states that the choice is spent without naming an address that does not work
   * here. Use the board that homes the service, or a key scoped to it.
   */
  linkedElsewhere: v.boolean(),
})
export type PublicRepo = v.InferOutput<typeof publicRepoSchema>

export const publicRepoListSchema = v.object({ repos: v.array(publicRepoSchema) })
export type PublicRepoList = v.InferOutput<typeof publicRepoListSchema>

/**
 * Declare that a task must wait for another one.
 *
 * The gap it closes: an integration filing five related tasks and starting them got five runs
 * racing against one repository, each opening a pull request against a base the others were
 * moving. The platform has had the mechanism to serialise them (the engine's start gate refuses a
 * task whose blockers are not `done`, and `autoStartDependents` starts a task when its blocker
 * merges) and no way for an external caller to be told about it.
 *
 * The edge is stored on the DEPENDENT: `POST /api/v1/tasks/{taskId}/dependencies` says "this task
 * waits for `dependsOnTaskId`". Both ends must be tasks (only a task ever reaches `done`, so an
 * edge onto a service or a module would wedge the run's start gate forever), and an edge that would
 * close a cycle is refused, so the gate and the auto-start can never deadlock.
 */
export const publicTaskDependencySchema = v.object({
  /** The task that must finish first. Must be a task in the same workspace, and not this one. */
  dependsOnTaskId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
})
export type PublicTaskDependencyInput = v.InferOutput<typeof publicTaskDependencySchema>

/**
 * A document attached to a task as agent context, as the task's document list serves it.
 *
 * Identified by `(source, externalId)` rather than by an id of its own, because that pair IS a
 * projected document's identity: a re-import of the same page lands on the same row, which is what
 * makes attaching one idempotent. `source` is `upload` for a body a caller carried rather than
 * named, and such a document has no page behind it, which is why `url` is empty there rather than
 * absent.
 */
export const publicAttachedDocumentSchema = v.object({
  /** Which source the document came from, or `upload` for one a caller carried inline. */
  source: documentOriginSchema,
  /** The source's stable id for the page: the value to pass back to detach it. */
  externalId: v.string(),
  title: v.string(),
  /** Canonical URL on the source; EMPTY for an `upload`, which has no page to link back to. */
  url: v.string(),
  /** A short plain-text excerpt of the body (the full text reaches the run, not this list). */
  excerpt: v.string(),
})
export type PublicAttachedDocument = v.InferOutput<typeof publicAttachedDocumentSchema>

export const publicAttachedDocumentListSchema = v.object({
  documents: v.array(publicAttachedDocumentSchema),
})
export type PublicAttachedDocumentList = v.InferOutput<typeof publicAttachedDocumentListSchema>

/**
 * Attach a requirements document to a task that already exists.
 *
 * The same two forms creation takes ({@link publicTaskDocumentSchema}): NAME a page in a connected
 * document source, or CARRY the text. What it adds is the moment: a task's spec routinely arrives
 * after the task does (a ticket filed first and specified later, a PRD that lands mid-review), and
 * until this existed the only way to attach one was to delete the task and file it again, losing
 * the id every stored reference points at, its ticket claim (which then refuses every future filing
 * of that ticket) and the documents it already carried.
 *
 * A document a DIFFERENT live task already holds is refused rather than moved: a document row
 * carries exactly one attachment, so moving it would strip the other task of a document it was
 * created with, with nothing in its next run reporting the absence.
 */
export const attachPublicTaskDocumentSchema = v.object({
  document: publicTaskDocumentSchema,
})
export type AttachPublicTaskDocumentInput = v.InferOutput<typeof attachPublicTaskDocumentSchema>

/**
 * Detach a document from a task, naming it by the `(source, externalId)` pair the task's document
 * list serves.
 *
 * A POST with a body rather than a `DELETE .../documents/{id}`, because a document's identity is
 * two values and one of them is a free-form external id: a Confluence page id is fine in a path
 * segment and a GitHub docs path (`docs/architecture/adr-0001.md`) is not, so half the sources
 * would need escaping rules a caller has to get right to address its own document.
 *
 * The document itself SURVIVES: it stays in the workspace exactly as the app's own detach leaves
 * it, so re-attaching it costs no re-import. Idempotent: detaching a document this task does not
 * hold is a no-op rather than an error, because a caller retrying after a timeout should converge
 * rather than have to distinguish "it was never attached" from "I already detached it".
 */
export const detachPublicTaskDocumentSchema = v.object({
  source: documentOriginSchema,
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type DetachPublicTaskDocumentInput = v.InferOutput<typeof detachPublicTaskDocumentSchema>
