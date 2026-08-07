import * as v from 'valibot'
import { blockTypeSchema, DOC_KINDS } from './primitives.js'

// ---------------------------------------------------------------------------
// Document-source integration wire contracts. A workspace can connect to one or
// more external document sources (Confluence, Notion, …), import requirement /
// RFC / PRD pages from them (projected locally), expand a page into board
// structure, or attach it to a task as agent context.
//
// The shapes here are deliberately source-agnostic: a `source` discriminator
// tags every connection and document, and each provider describes the
// credentials it needs via a {@link DocumentSourceDescriptor} so the UI can be
// rendered generically. Storage-only bookkeeping (the owning workspace, the
// credential bag, the soft-delete tombstone, the cached page body) is NOT on the
// wire — it lives in the core ports / D1 layer.
// ---------------------------------------------------------------------------

/**
 * The external document sources cat-factory can CONNECT to. Every member has a
 * {@link DocumentSourceProvider} behind it, so this is the vocabulary of everything that can be
 * connected, searched, imported from and re-probed for a fresher version.
 *
 * It is deliberately NARROWER than {@link documentOriginSchema}: a stored document need not have
 * come from a source at all.
 */
export const documentSourceKindSchema = v.picklist([
  'confluence',
  'notion',
  'github',
  'figma',
  'zeplin',
  'linear',
])
export type DocumentSourceKind = v.InferOutput<typeof documentSourceKindSchema>

/**
 * Where a STORED document came from: one of the connected sources above, or `upload` for a body
 * handed to the platform directly (today by a `/api/v1` caller attaching a spec to the task it is
 * creating, which is the whole reason this widening exists).
 *
 * Two vocabularies rather than one because a provider is what tells them apart. Everything a
 * provider does (connect, search, import a ref, `probeVersion` a stored copy against the live
 * page) is defined only for a {@link DocumentSourceKind}, and there is no `upload` provider to
 * ask. Keeping the narrow union on those surfaces is what makes the absence a COMPILE error
 * (an exhaustive `Record<DocumentSourceKind, DocumentSourceDescriptor>` still has to name every
 * member) instead of a runtime `undefined` at whichever call site reaches for the missing
 * provider first. The wide union covers only what a stored row and its block/role links carry,
 * where the origin is a label rather than a capability.
 */
export const documentOriginSchema = v.picklist([
  // DERIVED from the narrow union rather than restated, so a source added there cannot be
  // forgotten here and leave rows the wide union refuses to describe.
  ...documentSourceKindSchema.options,
  'upload',
])
export type DocumentOrigin = v.InferOutput<typeof documentOriginSchema>

/** True for an origin that has a provider behind it (so it can be re-imported / re-probed). */
export function isConnectableSource(origin: DocumentOrigin): origin is DocumentSourceKind {
  return (documentSourceKindSchema.options as readonly string[]).includes(origin)
}

/**
 * What a source IS, as opposed to what its provider can do. Two facts the backend and the SPA both
 * have to agree about, which is why they live here rather than on the provider: the engine folds
 * design guidance from the first, the URL canonicaliser orders itself by the second, and a document
 * surface has to label a design source as one without asking a provider it cannot see.
 */
export interface DocumentSourceTraits {
  /**
   * The source describes a DESIGN (frames, components, tokens) rather than prose. What makes an
   * agent's design guidance applicable, so it is a property of the source and not of the page: a
   * Figma file is a design whether or not the frame someone linked happens to hold text.
   */
  readonly design: boolean
  /**
   * `parseRef` refuses a URL that is not on the source's OWN host, so a claim over one is
   * high-confidence evidence of a reference. A host-BLIND parser claims a shape instead
   * (`parseNotionRef` any UUID-shaped run, `parseConfluenceRef` any `/pages/<digits>` segment) and
   * will therefore claim a dashboard link that has nothing to do with it. This is what
   * `makeDocumentUrlResolver` orders by: consulted first-registered, a blind parser steals a
   * pinned source's own URL.
   */
  readonly hostPinned: boolean
  /**
   * The source's credentials are SELF-CONTAINED, so a deployment can configure one centrally and
   * the provider will authenticate with it alone.
   *
   * The trait that decides whether a source can back a DEPLOYMENT-scoped document (the living
   * standard a code-registered prompt fragment names). It is false for exactly one reason, and
   * `github` is the case: its credential is not a bag at all but the WORKSPACE's own App
   * installation, resolved per read (`resolveImplicitConnection`, `resolveInstallationId`). There
   * is no deployment-wide value to configure, and picking a tenant's installation to read on the
   * whole deployment's behalf is the cross-tenant fetch this trait exists to refuse.
   *
   * Declared here rather than inferred from whether a provider happens to ignore its `workspaceId`
   * argument: that is an implementation detail one refactor away from changing silently, and the
   * consequence of getting it wrong is one tenant's credential fetching text into another's
   * prompts.
   */
  readonly deploymentScoped: boolean
}

/**
 * Every source's traits, exhaustive over the union so a new source cannot ship unclassified: the
 * `Record` fails to compile until it is named here, and there is no default to fall into.
 */
const DOCUMENT_SOURCE_TRAITS: Record<DocumentSourceKind, DocumentSourceTraits> = {
  confluence: { design: false, hostPinned: false, deploymentScoped: true },
  notion: { design: false, hostPinned: false, deploymentScoped: true },
  // The one source whose credential is a WORKSPACE's App installation rather than a bag a
  // deployment could configure. See `DocumentSourceTraits.deploymentScoped`.
  github: { design: false, hostPinned: true, deploymentScoped: false },
  figma: { design: true, hostPinned: true, deploymentScoped: true },
  zeplin: { design: true, hostPinned: true, deploymentScoped: true },
  linear: { design: false, hostPinned: true, deploymentScoped: true },
}

/**
 * Whether a stored document came from a DESIGN source. Takes the WIDE origin union because the
 * callers hold a stored row: an `upload` is prose the platform was handed, so it is never a design
 * (a design source is reached through its API, not pasted as Markdown).
 */
export function isDesignSource(origin: DocumentOrigin): boolean {
  return isConnectableSource(origin) && DOCUMENT_SOURCE_TRAITS[origin].design
}

/** Whether a source's `parseRef` is pinned to its own host. See {@link DocumentSourceTraits}. */
export function isHostPinnedSource(source: DocumentSourceKind): boolean {
  return DOCUMENT_SOURCE_TRAITS[source].hostPinned
}

/**
 * Whether a DEPLOYMENT can configure this source centrally, so a code-registered prompt fragment
 * may name a living document from it. See {@link DocumentSourceTraits.deploymentScoped}.
 */
export function isDeploymentScopedSource(source: DocumentSourceKind): boolean {
  return DOCUMENT_SOURCE_TRAITS[source].deploymentScoped
}

/** Every source a deployment may configure centrally, in picklist order. */
export function deploymentScopedSources(): DocumentSourceKind[] {
  return documentSourceKindSchema.options.filter(isDeploymentScopedSource)
}

/**
 * Order sources by how much a claim over a URL is WORTH: host-pinned first, registration order
 * within each pass. Every caller that asks "which source does this text belong to" reads this,
 * because the answer is only as good as the ordering (see {@link DocumentSourceTraits.hostPinned}):
 * a blind parser claims a SHAPE, so letting registration order decide points a Figma paste at
 * Notion.
 *
 * ONE function rather than the same two `filter`s at each call site (`makeDocumentUrlResolver`
 * canonicalising a URL named in prose, `DocumentImportService.claimingSource` naming the claimant
 * in a refusal). The failure mode of a second copy is precisely the silent mis-attribution the
 * ordering exists to prevent: refining the rule in one place would leave the other pointing the
 * same paste at the wrong source.
 */
export function orderSourcesByClaimConfidence<T extends { kind: DocumentSourceKind }>(
  sources: readonly T[],
): T[] {
  return [
    ...sources.filter((s) => isHostPinnedSource(s.kind)),
    ...sources.filter((s) => !isHostPinnedSource(s.kind)),
  ]
}

// ---- Freshness: how current a stored projection is ------------------------

/**
 * Why the platform could not confirm a source-backed document against its source. Each member
 * needs a DIFFERENT fix, which is the whole reason they are not one value:
 *
 * - `not_connected`: the workspace's connection to the source is gone (revoked/disconnected), so
 *   reconnecting it is the remedy.
 * - `credentials_unreadable`: the connection could not be READ at all, so the platform never got
 *   as far as asking the source. Distinct from `not_connected` (a definite "there is no
 *   connection") because the remedy is the deployment's, not the workspace's, and distinct from
 *   `source_unreachable` because the source is not the thing that failed. What makes it
 *   load-bearing rather than defensive is MOTHERSHIP MODE, where a document-source connection is
 *   sealed with the mothership's key and therefore cannot be served to a node at all: the read
 *   fails permanently and by design there, and reporting it as an outage would send an operator
 *   hunting a Figma incident that does not exist.
 * - `unversioned`: the source answered but exposes no version token to compare, so there is
 *   nothing to fix. Saying so beats implying the copy was checked.
 * - `source_unreachable`: the probe or the re-fetch failed (a 403, a rate limit, an outage). The
 *   stored body is still served; the operator's log line carries the cause.
 *
 * It lives HERE rather than in kernel because both sides have to agree about it: the engine
 * renders the agent-facing warning from it, and the SPA states the same verdict to a human in
 * their own language off an exhaustive `Record` keyed by these members (the backend does not
 * localize prose).
 */
export const documentFreshnessGapSchema = v.picklist([
  'not_connected',
  'credentials_unreadable',
  'unversioned',
  'source_unreachable',
])
export type DocumentFreshnessGap = v.InferOutput<typeof documentFreshnessGapSchema>

/**
 * What a confirmed check found had changed in the board's copy. None of the three is a degradation
 * (all leave the reader on the live revision), but they answer "did my edit land" differently and
 * the middle one is the reason this is not a boolean:
 *
 * - `unchanged`: the source is still at the revision the stored copy was taken from. Nothing was
 *   fetched and nothing was written.
 * - `reimported`: the source had moved on, and the copy an agent reads was rewritten from it.
 * - `revision_only`: the source's revision token moved, but nothing an agent reads differs. This is
 *   the NORMAL case for a whole-file source with a per-file version: a Figma file's version bumps on
 *   any edit anywhere in it, including frames a given document does not cover. Folding it into
 *   `reimported` would tell a person their design was pulled in when their own edit may not have
 *   been touched at all, and it is exactly the false confidence this vocabulary exists to remove.
 *
 * A closed picklist rather than a boolean for the same reason `DocumentFreshnessGap` is: the SPA
 * keys translated copy off these members, and adding one has to fail a build rather than render an
 * empty line.
 */
export const documentFreshnessChangeSchema = v.picklist([
  'unchanged',
  'reimported',
  'revision_only',
])
export type DocumentFreshnessChange = v.InferOutput<typeof documentFreshnessChangeSchema>

/**
 * What a refresh attempt concluded about one linked document.
 *
 * A source-backed document is a PROJECTION of a page someone else keeps editing, so "is the copy
 * we are about to read the current one" is a question with THREE answers, not two. "No source to
 * confirm against" and "tried and failed" are different facts: an `upload` has nothing to be stale
 * relative to, while a Figma file the API refused may well be behind the live design. Only the
 * second is a warning, and only a `confirmed` verdict can name a revision.
 */
export const documentFreshnessSchema = v.variant('status', [
  /**
   * Checked against the source, which is now known to be the revision named here. What the check
   * had to DO to get there is {@link DocumentFreshnessChange}.
   */
  v.object({
    status: v.literal('confirmed'),
    version: v.string(),
    change: documentFreshnessChangeSchema,
  }),
  /**
   * Nothing to confirm against: an `upload` body the platform was handed directly, or a source
   * this deployment has no provider wired for. Not a gap and not a warning, because no fresher
   * copy exists.
   */
  v.object({ status: v.literal('not-applicable') }),
  /** The platform tried and could not confirm. The stored body stands; see the reason. */
  v.object({ status: v.literal('unconfirmed'), reason: documentFreshnessGapSchema }),
])
export type DocumentFreshness = v.InferOutput<typeof documentFreshnessSchema>

/**
 * One linked document a DISPATCH put in front of an agent, and the freshness verdict that
 * dispatch reached about it.
 *
 * The verdict is computed per dispatch and rendered into the agent's context, where it does its
 * job and then vanishes with the container. So "which revision did this run build against" was
 * answerable only while the run was still live, and only by re-probing the source, which by then
 * answers about the CURRENT revision, not the one the agent read. A design under active iteration
 * is exactly where that question gets asked, and exactly where re-probing gives the wrong answer.
 *
 * Recorded on the step for the same reason `toolServers` and `skillVersions` are: it is what the
 * dispatch resolved and no later reader can re-derive. The BODY is deliberately not here: it is
 * large, it is already in the documents table, and what is unrecoverable is the pairing of a
 * document with the revision this step read.
 *
 * `freshness` absent means the deployment ran no check at all (no refresher wired), which is not
 * the same as {@link DocumentFreshness}'s `unconfirmed`: nobody asked, versus asked and could not
 * tell. Only the second is a warning about the copy.
 */
export const stepContextDocumentSchema = v.object({
  title: v.string(),
  /**
   * The source's own id for this page, which is what makes a row IDENTIFIABLE across the
   * dispatches that read it. It is carried rather than derived because the two visible fields
   * cannot stand in for it: `url` is EMPTY for an `upload`, so a key falling back to the title
   * would merge two same-titled uploads into one row and read their differing revisions as a
   * single page that MOVED mid-run. Same `(origin, externalId)` pair the
   * document repository and the linked-context resolver key by.
   */
  externalId: v.string(),
  /** Canonical URL on the source. EMPTY for an `upload`, which has no source to link to. */
  url: v.string(),
  origin: documentOriginSchema,
  freshness: v.optional(documentFreshnessSchema),
})
export type StepContextDocument = v.InferOutput<typeof stepContextDocumentSchema>

/**
 * The role a workspace+`DocKind`-scoped document link plays for the forward document-authoring
 * track (WS1 items 2–4). A `template` link's parsed sections REPLACE the built-in skeleton for
 * that kind (singular per kind — linking a new one replaces the prior override); `exemplar`
 * links are a "good example to emulate" list the author agents are pointed at (multi-valued).
 * Both ride the SAME document projection + read path as a block-scoped context link — the only
 * new surface is this role/`docKind` tagging (design record: `backend/docs/adr/0017-*`).
 */
export const documentLinkRoleSchema = v.picklist(['template', 'exemplar'])
export type DocumentLinkRole = v.InferOutput<typeof documentLinkRoleSchema>

// ---- Provider self-description (drives the generic connect UI) ------------

/** One credential a provider needs to connect (rendered as a form field). */
export const credentialFieldSchema = v.object({
  /** Stable key stored in the credential bag (e.g. `apiToken`). */
  key: v.string(),
  /** Human label for the form field. */
  label: v.string(),
  /** Optional helper text shown under the field. */
  help: v.optional(v.string()),
  /** Optional input placeholder. */
  placeholder: v.optional(v.string()),
  /** Render as a password input and never echo the value back. */
  secret: v.optional(v.boolean()),
})
export type CredentialField = v.InferOutput<typeof credentialFieldSchema>

/**
 * A source's OAuth (`authorization_code`) connect half, when it declares one.
 *
 * Presence here says the SOURCE can be connected this way, never that this DEPLOYMENT can run the
 * flow: that needs a registered OAuth client, which is deployment configuration and is reported
 * separately (`oauthSources` on the source listing). The two are deliberately different facts,
 * because they need different fixes: a source with no OAuth half will never gain a button, while
 * one whose deployment has registered no client gains it the moment an admin does.
 */
export const documentSourceOAuthDescriptorSchema = v.object({
  /**
   * What the vendor's consent screen will ask for, so the operator reads it BEFORE being sent
   * there rather than on a page they cannot come back from without deciding.
   */
  scopes: v.array(v.string()),
})
export type DocumentSourceOAuthDescriptor = v.InferOutput<
  typeof documentSourceOAuthDescriptorSchema
>

/**
 * Everything the frontend needs to render a source's connect form and import
 * box without hard-coding any provider specifics.
 */
export const documentSourceDescriptorSchema = v.object({
  source: documentSourceKindSchema,
  /** Display name, e.g. `Confluence`. */
  label: v.string(),
  /** Lucide icon name for the source. */
  icon: v.string(),
  /** Credentials required to connect, in display order. */
  credentialFields: v.array(credentialFieldSchema),
  /** Label for the "import a page" input. */
  refLabel: v.string(),
  /** Placeholder for the "import a page" input. */
  refPlaceholder: v.string(),
  /**
   * Whether this source supports searching its catalogue by title/content (so
   * the UI offers a search box, not just a paste-a-URL field). Optional for
   * backward-compatibility; absent is treated as `false`.
   */
  searchable: v.optional(v.boolean()),
  /**
   * The source's OAuth connect half, when it has one. Absent means the credential fields above
   * are the ONLY way in; present means a deployment MAY additionally offer "Connect with <source>"
   * (see {@link documentSourceOAuthDescriptorSchema} for why presence is not availability).
   */
  oauth: v.optional(documentSourceOAuthDescriptorSchema),
})
export type DocumentSourceDescriptor = v.InferOutput<typeof documentSourceDescriptorSchema>

// ---- Connection + document projections ------------------------------------

/** A workspace's connection to a document source, as exposed to clients (never the credentials). */
export const documentConnectionSchema = v.object({
  source: documentSourceKindSchema,
  /** A human-friendly label for what we're connected to (site URL, workspace name). */
  label: v.string(),
  /** When the connection was established (epoch ms). */
  connectedAt: v.number(),
})
export type DocumentConnection = v.InferOutput<typeof documentConnectionSchema>

/** A page imported from a source (or uploaded through the API), projected locally. */
export const sourceDocumentSchema = v.object({
  source: documentOriginSchema,
  /** The source's stable id for the page (Confluence page id, Notion page id). */
  externalId: v.string(),
  title: v.string(),
  /**
   * Canonical URL of the page on the source, or EMPTY for an `upload`, which has no page to
   * link back to. Readers render the origin only when there is one: an empty parenthetical or a
   * bare `Source:` line reads as a broken link rather than as a document that never had one.
   */
  url: v.string(),
  /** A short plain-text excerpt of the body (full body stays in storage). */
  excerpt: v.string(),
  /** The board block this document is attached to as context, if any. */
  linkedBlockId: v.nullable(v.string()),
  /**
   * The workspace+`DocKind` link role this document plays, if any — `template` (its parsed
   * sections override the kind's built-in skeleton) or `exemplar` (a good example to emulate).
   * Null for a plain imported/block-linked document. Paired with {@link docKind}.
   */
  role: v.nullable(documentLinkRoleSchema),
  /** The document kind a `role`-tagged link is scoped to (null when the document carries no role). */
  docKind: v.nullable(v.picklist(DOC_KINDS)),
  /** When this projection row was last refreshed (epoch ms). */
  syncedAt: v.number(),
})
export type SourceDocument = v.InferOutput<typeof sourceDocumentSchema>

/**
 * A single hit from searching a source's catalogue. A lean shape (no body) used
 * to populate a picker: selecting one imports it (by `externalId`) and links it
 * to a block. Distinct from {@link SourceDocument} — a hit is not yet projected
 * locally, so it carries no `linkedBlockId`/`syncedAt`.
 */
export const documentSearchResultSchema = v.object({
  source: documentSourceKindSchema,
  /** The source's stable id for the page (re-usable as an import ref). */
  externalId: v.string(),
  title: v.string(),
  /** Canonical URL of the page on the source. */
  url: v.string(),
  /** A short plain-text excerpt for the result row (may be empty). */
  excerpt: v.string(),
})
export type DocumentSearchResult = v.InferOutput<typeof documentSearchResultSchema>

// ---- Board plan (doc → structure) -----------------------------------------

/** A proposed task within a planned frame/module. */
export const planTaskSchema = v.object({
  title: v.string(),
  description: v.optional(v.string()),
})
export type PlanTask = v.InferOutput<typeof planTaskSchema>

/** A proposed module grouping tasks within a planned frame. */
export const planModuleSchema = v.object({
  name: v.string(),
  tasks: v.array(planTaskSchema),
})
export type PlanModule = v.InferOutput<typeof planModuleSchema>

/** A proposed top-level frame (service/api/…) with its modules and loose tasks. */
export const planFrameSchema = v.object({
  type: blockTypeSchema,
  title: v.string(),
  description: v.optional(v.string()),
  modules: v.array(planModuleSchema),
  tasks: v.array(planTaskSchema),
})
export type PlanFrame = v.InferOutput<typeof planFrameSchema>

/**
 * A proposed board structure extracted from an imported document. `planner`
 * records whether an LLM produced it or the deterministic heading parser did, so
 * the UI can label a preview honestly.
 */
export const documentBoardPlanSchema = v.object({
  // The origin is echoed back from the planned document's own key, so it is as wide as a stored
  // row: planning reads the cached body and asks nothing of a provider.
  source: documentOriginSchema,
  externalId: v.string(),
  planner: v.picklist(['llm', 'headings']),
  /**
   * The existing service frame this plan was authored FOR, or null when it proposes a whole
   * architecture at the board root.
   *
   * The preview reads completely differently under the two: a board-scoped plan's `frames` are
   * services about to be created, while a targeted plan carries exactly ONE frame standing for the
   * target, whose modules and tasks are what will be added inside it. Without this the SPA would
   * announce three new services over a spawn that creates three modules in one.
   *
   * It is also what makes the `frameId` spawn honest. Flattening a board-scoped plan into a frame
   * discards the frame titles, types and descriptions the preview rendered, which is why the SPA
   * never sent one; a plan authored for the target discards nothing, because the single frame IS
   * the target.
   */
  targetFrameId: v.nullable(v.string()),
  frames: v.array(planFrameSchema),
})
export type DocumentBoardPlan = v.InferOutput<typeof documentBoardPlanSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Connect a workspace to a document source. The `credentials` bag is validated
 * by the target provider (the `:source` is in the path), keeping the wire shape
 * uniform across providers.
 */
export const connectDocumentSourceSchema = v.object({
  credentials: v.record(
    v.string(),
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
  ),
})
export type ConnectDocumentSourceInput = v.InferOutput<typeof connectDocumentSourceSchema>

/** Import (fetch + persist) a page by its id or a full page URL. */
export const importDocumentSchema = v.object({
  ref: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type ImportDocumentInput = v.InferOutput<typeof importDocumentSchema>

// ---- Reference resolution (the check that runs before anything is written) --

/** Canonicalise a pasted URL/id into the reference the source would store it under. */
export const resolveDocumentRefSchema = importDocumentSchema
export type ResolveDocumentRefInput = v.InferOutput<typeof resolveDocumentRefSchema>

/**
 * What a pasted URL/id resolves to for one source: the stable key the platform would store the
 * page under, plus the canonical link to show the person who pasted it.
 */
export const resolvedDocumentRefSchema = v.object({
  source: documentSourceKindSchema,
  /** The `(source, externalId)` key an import would land on. */
  externalId: v.string(),
  /**
   * The canonical web URL for {@link externalId}, with the title segment and tracking params a
   * share link carries dropped: the "supported format" the paste is trimmed to.
   *
   * Null when the source cannot rebuild a URL from the id alone: a Confluence page id needs the
   * site base URL and a Linear document id the workspace slug, neither of which the id carries.
   * That is "there is no link to show you", NOT a weaker reference, so a reader renders the
   * `externalId` rather than treating the null as a failed resolution.
   */
  canonicalUrl: v.nullable(v.string()),
  /**
   * The NARROWING the paste carried that the resolved reference does not: the frame/screen the URL
   * named, which the source could not read as an id. Null when nothing was dropped.
   *
   * Its own field because it is the opposite fact from a trim, and a reader with only the canonical
   * form cannot tell them apart. Dropping a share link's title segment and `?p=`/`&t=` params
   * REMOVES NOISE and resolves the same page; dropping an unreadable `node-id` WIDENS the reference
   * from one frame to the whole design file. Both render as "this is not quite what you pasted", so
   * a surface that states only the trim tells someone who attached one frame nothing about the
   * agent then reading the entire file.
   *
   * The value is the qualifier as pasted (`I2649:14930;2649:14746`), because the person who pasted
   * it is the only one who can decide whether the whole file is acceptable, and naming what was
   * dropped is what lets them recognise it. Never GUESSED back onto a supported form: the parser
   * refused it precisely because nothing knows which frame it meant.
   */
  droppedScope: v.nullable(v.string()),
})
export type ResolvedDocumentRef = v.InferOutput<typeof resolvedDocumentRefSchema>

/**
 * Why a pasted reference was refused, carried as `error.details.reason` on the 422 so the SPA
 * can state it in the reader's own language (the backend does not localize prose).
 *
 * Two members rather than one because they ask for DIFFERENT corrections. `unrecognized` means
 * the text is not a reference this source could ever accept, and the only fix is a different
 * link. `claimed_by_other_source` means the link is perfectly good and pointed at the wrong
 * source, which is fixed by switching the picker with the same text still in it. Collapsing
 * them would tell someone who pasted a valid Figma frame URL that their link is malformed.
 */
export const documentRefReasonSchema = v.picklist([
  'document_ref_unrecognized',
  'document_ref_claimed_by_other_source',
])
export type DocumentRefReason = v.InferOutput<typeof documentRefReasonSchema>

// ---- Manual refresh (the human dual of the dispatch-time one) --------------

/**
 * Re-confirm ONE stored document against its source right now: probe, and re-import if the page
 * moved. The same ladder every dispatch runs, asked for by a person instead of by a run.
 *
 * `source` is the NARROW union, so an `upload` is refused at the boundary rather than answered
 * with a `not-applicable` verdict. There is no provider to ask about a body the platform was
 * handed directly, and a 200 saying so would leave the caller unable to tell "this document has no
 * source" from "the check ran and found nothing to compare", which is exactly the distinction the
 * freshness vocabulary exists to keep.
 */
export const refreshDocumentSchema = v.object({
  source: documentSourceKindSchema,
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type RefreshDocumentInput = v.InferOutput<typeof refreshDocumentSchema>

/**
 * The refreshed projection plus what the check concluded about it.
 *
 * Both halves, because neither answers on its own: the document carries the (possibly rewritten)
 * title/excerpt/`syncedAt` a caller has to re-render, and the verdict is the only thing that says
 * whether the copy was CONFIRMED current. An unchanged document with an `unconfirmed` verdict and
 * one with a `confirmed` one are byte-for-byte identical rows and opposite facts.
 */
export const refreshedDocumentViewSchema = v.object({
  document: sourceDocumentSchema,
  freshness: documentFreshnessSchema,
})
export type RefreshedDocumentView = v.InferOutput<typeof refreshedDocumentViewSchema>

/** Search a source's catalogue by free text (title/content). */
export const searchDocumentsSchema = v.object({
  query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
})
export type SearchDocumentsInput = v.InferOutput<typeof searchDocumentsSchema>

/**
 * Preview the board structure a page would expand into (no writes).
 *
 * `frameId` makes the plan TARGET-AWARE: the planner is told which service it is proposing work
 * inside, and answers with that frame's modules and tasks rather than an architecture. It is the
 * same frame the following spawn is given, so the preview and the write agree about the target.
 */
export const planDocumentSchema = v.object({
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  frameId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
})
export type PlanDocumentInput = v.InferOutput<typeof planDocumentSchema>

/**
 * Apply a previously-imported page's structure to the board. Without `frameId`
 * the plan's frames are spawned at the board root; with it, the plan's modules
 * and tasks are spawned inside that existing frame.
 */
export const spawnDocumentSchema = v.object({
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  frameId: v.optional(v.pipe(v.string(), v.minLength(1))),
})
export type SpawnDocumentInput = v.InferOutput<typeof spawnDocumentSchema>

/** Attach an imported (or uploaded) page to a task as extra agent context. */
export const linkDocumentSchema = v.object({
  source: documentOriginSchema,
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  blockId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type LinkDocumentInput = v.InferOutput<typeof linkDocumentSchema>

/**
 * Tag an imported page as the workspace's `template` or `exemplar` for a document kind (WS1).
 * The page must already be imported (like {@link linkDocumentSchema}, the link references a
 * projected document by its stable `(source, externalId)` key). A `template` role is singular
 * per kind — linking a new one replaces the prior override.
 */
export const linkDocumentForKindSchema = v.object({
  source: documentOriginSchema,
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  role: documentLinkRoleSchema,
  docKind: v.picklist(DOC_KINDS),
})
export type LinkDocumentForKindInput = v.InferOutput<typeof linkDocumentForKindSchema>

/** Clear a document's workspace+`DocKind` role tag (falls back to the built-in template / drops the exemplar). */
export const unlinkDocumentForKindSchema = v.object({
  source: documentOriginSchema,
  externalId: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type UnlinkDocumentForKindInput = v.InferOutput<typeof unlinkDocumentForKindSchema>
