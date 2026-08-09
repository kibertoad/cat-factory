// The Cloudflare OS gatekeeper contract, transcribed.
//
// The published source (`cloudflare/cloudflare-os`, `packages/workshop-shared/src/gatekeeper.ts`)
// is the authority for every shape below. It is TRANSCRIBED rather than imported because this
// package depends on the cat-factory public surface and nothing else: taking a dependency on the
// partner workspace would make their release cadence this package's build, which is the same
// coupling the initiative's own CI rule refuses. The cost is that these declarations can fall
// behind, and the answer to that is the nightly leg (`GATEKEEPER_OS_REF`), which boots a pinned
// partner commit against this Worker and is allowed to go red on its own.
//
// The transcription is deliberately PARTIAL: it carries the members this Worker implements or is
// handed, and omits the ones it does not (`getAgentCatalog`, `getSlashCommandProvider`,
// `startAppUi`, the UI frames). An omitted optional member is a capability the OS correctly
// reports as absent; a transcribed one this Worker did not implement would be a method that
// exists and lies.
//
// Structural typing is what makes this safe. Nothing here is `extends`ed by a class the OS
// constructs: the OS reaches a bound Worker's entrypoint over native RPC and calls methods by
// name, so what has to match is the SHAPE. These interfaces exist to make our shape a compile-time
// claim rather than a hope.

/** An image the workspace renders beside a vendor, an account or a resource. */
export interface AvatarImage {
  url: string
}

/**
 * The stable tag an OS admin rule is keyed on, plus the label a human reads.
 *
 * The tag has to survive a rename of the label, because a pre-approval rule an operator wrote
 * months ago is matched by it. Ours is the binding name, which is generated from the operation's
 * own group and method, so it is exactly as stable as the public API is.
 */
export interface ActionKind {
  tag: string
  label: string
}

/** What the OS shows about a vendor before any account exists. */
export interface VendorDescription {
  displayName: string
  url: string
  logo?: AvatarImage
  color?: string
  tagline?: string
  description?: string
  /** True only if the connect flow yields a provider-verified email. Ours does not. */
  providesAuth?: boolean
  /** True when the vendor can mint an account with no OAuth flow (see `createAccount`). */
  autoProvisionsAccount?: boolean
}

/** A class of thing this vendor can serve, matched against a URL by `urlPattern`. */
export interface SupportedResource {
  /** A URLPattern string, e.g. `https://cat-factory.example.com/*`. */
  urlPattern: string
  title: string
  description: string
  icon?: AvatarImage
  /** True when the account must be granted access to this type separately. */
  grantable?: boolean
}

/** What the OS shows about one connected account. */
export interface AccountDescription {
  displayName?: string
  /** The canonical, unique name for the account. */
  uniqueName?: string
  avatar: AvatarImage
  grantedResourceUrlPatterns?: string[]
}

/** What the OS shows about one bound resource, and how it types the session behind it. */
export interface ResourceDescription {
  /** The resource's canonical URL: visiting it in a browser opens the resource's own UI. */
  url: string
  title: string
  snippet: string
  /** The name the binding is first created with. The user may rename it. */
  suggestedBindingName: string
  /** A type name exported by this gatekeeper's `getTypeScriptTypes()`. */
  tsType: string
}

/**
 * A read the gadget wants to make, described for the authorizer.
 *
 * `prohibitAllSharing` is the strongest statement available and the one worth getting right: it
 * says the data this read returns may not be shared onward with any observer, whatever their own
 * access is.
 */
export interface ObservationDescription {
  title: string
  description: string
  prohibitAllSharing?: boolean
  excludeObservers?: string[]
}

/** A side effect the gadget wants to make, described for the approver. */
export interface ActionDescription {
  /** One line, like an email subject, for a list. */
  title: string
  /** Markdown. Everything an approver needs in order to decide, with nothing held back. */
  description: string
  /** Whether this gatekeeper implements `revertAction` for this action. */
  implementsRevert: boolean
  /**
   * Tells the agent not to keep working until this settles. Set by a gatekeeper that does NOT
   * simulate the action's effects, which is ours: there is no provisional run id to hand back.
   */
  awaitDecision?: boolean
  /** The author's verdict that this action is safe to auto-apply, if the user opted in. */
  autoApprovable?: boolean
  actionKind?: ActionKind
}

/** The half of the queue that governs reads. */
export interface ObservationAuthorizer {
  /** Resolves when the read is permitted, and THROWS when it is not. */
  authorizeObservation(description: ObservationDescription): Promise<void>
}

/**
 * What the OS hands to `startSession`: the chokepoint every operation passes through.
 *
 * `submitAction` takes an id this gatekeeper assigns and returns as soon as the action is QUEUED,
 * not when it is decided. The decision arrives later as `applyAction(id)` or `rejectAction(id)` on
 * the resource object.
 */
export interface ApprovalQueue extends ObservationAuthorizer {
  submitAction(action: number, description: ActionDescription): Promise<void>
}

// The three objects THIS Worker serves, declared as what it implements rather than left to
// inference. Each factory below returns a constructor typed against one of them, which is doing two
// jobs at once: it is the compile-time claim that our shape matches the contract above, and it is
// what lets a factory return a class at all (TypeScript will not emit a declaration for an exported
// class expression carrying private members, and every entrypoint base class has some).

/** What a `GATEKEEPER_*` service binding reaches. */
export interface VendorEntrypoint {
  describe(): Promise<VendorDescription>
  getSupportedResources(options?: { userId?: string }): Promise<SupportedResource[]>
  getTypeScriptTypes(): Promise<string>
  /** Returns the account stub the workspace persists. Opaque here: it is the OS's to hold. */
  createAccount(): Promise<unknown>
}

/** What the workspace holds for one connected account. */
export interface AccountEntrypoint {
  describe(): Promise<AccountDescription>
  getSupportedResources(): Promise<SupportedResource[]>
  getGatekeeperClassFor(url: string): Promise<{ class: unknown; resource: SupportedResource }>
  ensureResources(resourceUrlPatterns: string[]): Promise<Record<string, never>>
  revoke(): Promise<void>
  getVerifier(): Promise<unknown>
  getAuthenticatedEmail(): Promise<string | null>
  reconnect(): Promise<{ url: string }>
}

/** What one bound resource serves: the session, its types, and the action lifecycle. */
export interface ResourceObject {
  describe(): Promise<ResourceDescription>
  getTypeScriptTypes(): Promise<string>
  startSession(approvalQueue: ApprovalQueue): Promise<unknown>
  getAutoApprovableActions(): Promise<ActionKind[]>
  applyAction(action: number): Promise<void>
  rejectAction(action: number): Promise<void>
  revertAction(action: number): Promise<{ message: string; canRetry: false }>
  addObserver(id: string, user: unknown): Promise<void>
  removeObserver(id: string): Promise<void>
}

/** The identity stub another vendor's gatekeeper is handed. Carries no authority by design. */
export interface VerifierEntrypoint {
  describe(): Promise<{ accountId: string }>
}
