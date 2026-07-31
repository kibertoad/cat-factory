import type { NavContribution, NavGates } from './nav-contributions'

/**
 * EXTERNAL TOOLS — a deployment's own web applications, registered programmatically and
 * listed in their own "External tools" sidebar section (and in the command palette).
 * Clicking one opens it in a separate browser page.
 *
 * The point is not the link; it is the CONTEXT that rides on it. A deployment's map editor,
 * asset pipeline or admin console is almost always already scoped to something cat-factory
 * knows — the signed-in user, the open workspace, or a workspace-specific identifier the
 * deployment declared as a custom metadata field ("this board is game `zork`"). So a tool
 * declares a {@link ExternalToolUrlResolver} — a pure function from the invocation context to
 * a URL — instead of a static link, and lands the user on the right state instead of the
 * tool's front door.
 *
 * Everything here is PURE (no Vue, no stores): the composable that renders these
 * (`useNavContributions`) builds the {@link ExternalToolContext} from the auth/workspace/
 * settings stores and hands it in, so the resolution rules stay unit-testable and the click
 * behaviour stays in one place.
 */

/** What a resolver may read about the invocation. Every field is data the SPA already holds. */
export interface ExternalToolContext {
  /** The signed-in user's id, or null when the deployment runs with auth disabled. */
  userId: string | null
  /** The signed-in user's email, or null (auth disabled, or a user record without one). */
  userEmail: string | null
  /** The open workspace's id. */
  workspaceId: string
  /** The open workspace's display name. */
  workspaceName: string
  /**
   * The workspace's custom metadata values, keyed by the field keys the deployment declared
   * (see {@link WorkspaceMetadataFieldDefinition}). A field nobody has filled in is ABSENT,
   * never `''` — which is what lets {@link resolveExternalToolUrl} report a missing value as
   * a missing value instead of building a URL with an empty parameter.
   */
  metadata: Readonly<Record<string, string>>
}

/**
 * Build the tool's URL from the invocation context. Returning `null` (or an empty string)
 * means "not resolvable right now" — the tool stays listed and says so when clicked, rather
 * than opening something wrong.
 */
export type ExternalToolUrlResolver = (context: ExternalToolContext) => string | null

/** One registered external tool. */
export interface ExternalToolContribution {
  /** Namespaced id (`<ns>:<name>`), like every other consumer contribution. */
  id: string
  /** Display name. Literal copy, not an i18n key: a tool's name is deployment DATA (the same
   *  class as a custom agent kind's `presentation.label`), and the deployment ships whatever
   *  locales it needs in its own catalog. */
  title: string
  /** One line of "what is this and why would I click it", shown as the item's tooltip. */
  description?: string
  /** Icon name (the same `i-lucide-*` vocabulary as every nav item). */
  icon: string
  /**
   * Where the tool lives: a fixed URL, or a resolver that folds the invocation context in.
   * Must resolve to an `http(s)` URL — anything else is refused (see
   * {@link resolveExternalToolUrl}).
   */
  url: string | ExternalToolUrlResolver
  /**
   * Metadata field keys the resolver needs. Checked BEFORE the resolver runs, so an
   * unconfigured workspace gets a message naming the fields to fill in rather than the
   * generic "couldn't work out where this goes" a null return can only mean. Declaring them
   * is what turns "the tool is broken" into "somebody has to fill in `gameId`".
   */
  requiredMetadata?: readonly string[]
  /** Sidebar/palette order within the External tools section. Defaults to 0. */
  order?: number
  /** Reactive RBAC/availability predicate, exactly as on a {@link NavContribution}. */
  gate?: (gates: NavGates) => boolean
  /** Show only in advanced interface mode. */
  advanced?: boolean
  /** Stable selector for e2e. Defaults to `nav-external-tool-<id>`. */
  testId?: string
}

/** Why a tool's URL could not be produced. Each names a DIFFERENT fix. */
export type ExternalToolUnavailableReason =
  /** The workspace has not filled in metadata fields the tool declared as required. */
  | 'missing-metadata'
  /** The resolver ran and declined to produce a URL (its own conditions weren't met). */
  | 'unresolved'
  /** A URL was produced but isn't an `http(s)` link we may hand to the browser. */
  | 'unsafe-url'

/** A resolved tool URL, or the reason there isn't one. */
export type ExternalToolResolution =
  | { ok: true; url: string }
  | { ok: false; reason: ExternalToolUnavailableReason; missing: readonly string[] }

/**
 * Resolve a tool's URL for one invocation.
 *
 * Three refusals, deliberately distinct (the "distinguish the causes that need different
 * fixes" rule): a workspace that hasn't filled in `gameId` needs someone to open workspace
 * settings; a resolver that declined needs the deployment's own attention; a non-`http(s)`
 * URL is a bug in the registration. Collapsing them into one "unavailable" would send every
 * one of those to the wrong person.
 *
 * The scheme check is load-bearing, not hygiene: the resolved string is handed to
 * `window.open`, so a `javascript:` URL from a mis-built resolver would execute in the SPA's
 * own origin. An allow-list of `http:`/`https:` is the boundary — a relative or malformed
 * URL fails the `URL` parse and lands in the same refusal.
 */
export function resolveExternalToolUrl(
  tool: ExternalToolContribution,
  context: ExternalToolContext,
): ExternalToolResolution {
  const missing = (tool.requiredMetadata ?? []).filter((key) => !context.metadata[key])
  if (missing.length > 0) return { ok: false, reason: 'missing-metadata', missing }

  const raw = typeof tool.url === 'function' ? tool.url(context) : tool.url
  if (!raw) return { ok: false, reason: 'unresolved', missing: [] }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'unsafe-url', missing: [] }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'unsafe-url', missing: [] }
  }
  return { ok: true, url: parsed.toString() }
}

/** A tool projected onto the nav catalog, with its resolution already computed. */
export interface ExternalToolNavItem {
  tool: ExternalToolContribution
  resolution: ExternalToolResolution
  contribution: NavContribution
}

/** The sidebar/palette order a tool with no `order` takes. */
const DEFAULT_ORDER = 0

/**
 * Project registered tools onto {@link NavContribution}s in the `externalTools` section, so
 * the three nav shells render them exactly like every other destination — one catalog, one
 * renderer.
 *
 * Unresolvable tools are KEPT in the list, carrying their refusal. Hiding them would make a
 * workspace that hasn't filled in `gameId` indistinguishable from a deployment that never
 * registered the tool, and the person who can fix it is the one looking at the sidebar. The
 * caller supplies `onUnavailable`, which is what turns a click into a message naming the fix.
 */
export function projectExternalTools(
  tools: readonly ExternalToolContribution[],
  context: ExternalToolContext,
  handlers: {
    open: (url: string, tool: ExternalToolContribution) => void
    onUnavailable: (
      resolution: Extract<ExternalToolResolution, { ok: false }>,
      tool: ExternalToolContribution,
    ) => void
  },
): ExternalToolNavItem[] {
  return [...tools]
    .sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER))
    .map((tool, index) => {
      const resolution = resolveExternalToolUrl(tool, context)
      // Placement is the ALREADY-SORTED position, not the declared `order`: the sort is stable,
      // so tools sharing an order (the common case — nobody declares one) keep registration
      // order instead of collapsing onto one nav slot.
      const order = index
      const contribution: NavContribution = {
        id: tool.id,
        // The title is deployment data, so it rides `label` (literal) rather than `labelKey`;
        // `labelKey` still carries the section's own key so an accidental `t()` on it resolves.
        labelKey: 'nav.externalTools',
        label: tool.title,
        description: tool.description,
        icon: tool.icon,
        surfaces: ['sidebar', 'command'],
        testId: tool.testId ?? `nav-external-tool-${tool.id}`,
        sidebar: { group: 'externalTools', order },
        command: { group: 'externalTools', order },
        run: () => {
          // Re-resolve at CLICK time rather than reusing the projection's result: the context
          // is reactive (a teammate can fill in `gameId` while this sidebar is open), and a
          // captured stale resolution would keep reporting a fix that has already happened.
          const now = resolveExternalToolUrl(tool, context)
          if (now.ok) handlers.open(now.url, tool)
          else handlers.onUnavailable(now, tool)
        },
      }
      return { tool, resolution, contribution }
    })
}

/**
 * Drop the tools the caller may not see, on the same two independent axes as `navSlotFilter`
 * applies to `nav`: the interface tier, then the item's own RBAC/availability predicate. With
 * no gates service wired (tests, a bare install) everything passes, matching the dev-open
 * "absent access allows all" parity the nav filter keeps.
 */
export function filterExternalTools(
  tools: readonly ExternalToolContribution[],
  gates: NavGates | undefined,
): ExternalToolContribution[] {
  if (!gates) return [...tools]
  return tools.filter(
    (t) => (t.advanced ? gates.advancedMode : true) && (t.gate ? t.gate(gates) : true),
  )
}
