import type { DispatchedToolServer, ToolServerUnavailableReason } from '~/types/toolServers'
import { isToolServerUnavailableReason } from '~/types/toolServers'

// Presentation for what one dispatch decided about the tool servers (MCP) its agent kind declared.
//
// The lookup is by a wire value, so it lives here as an EXHAUSTIVE `Record` keyed off the contracts
// union rather than as a t() call over a key assembled at the call site: a reason added to the
// union would otherwise ship as a blank chip on the one surface whose whole job is to say why an
// agent never got a tool it was supposed to have.
//
// The copy is written for the person who can FIX it, which is the split the vocabulary itself is
// built on: a missing credential is a value to supply, a reserved one is a declaration to change,
// an unconnected OAuth server is somebody pressing Connect. That is the opposite audience from the
// same vocabulary's prose in the agent's prompt, which only needs to say "not available, do not
// try harder".

export interface ToolServerReasonPresentation {
  /** Short chip copy: the reason in two or three words. */
  chip: string
  /** One sentence naming what to change, for the row under the chip. */
  remedy: string
}

export const TOOL_SERVER_UNAVAILABLE_KEYS: Record<
  ToolServerUnavailableReason,
  ToolServerReasonPresentation
> = {
  harness_unsupported: {
    chip: 'panels.stepMeta.toolServers.reason.harness_unsupported',
    remedy: 'panels.stepMeta.toolServers.remedy.harness_unsupported',
  },
  transport_unsupported: {
    chip: 'panels.stepMeta.toolServers.reason.transport_unsupported',
    remedy: 'panels.stepMeta.toolServers.remedy.transport_unsupported',
  },
  missing_secret: {
    chip: 'panels.stepMeta.toolServers.reason.missing_secret',
    remedy: 'panels.stepMeta.toolServers.remedy.missing_secret',
  },
  reserved_secret: {
    chip: 'panels.stepMeta.toolServers.reason.reserved_secret',
    remedy: 'panels.stepMeta.toolServers.remedy.reserved_secret',
  },
  oauth_not_connected: {
    chip: 'panels.stepMeta.toolServers.reason.oauth_not_connected',
    remedy: 'panels.stepMeta.toolServers.remedy.oauth_not_connected',
  },
  oauth_token_failed: {
    chip: 'panels.stepMeta.toolServers.reason.oauth_token_failed',
    remedy: 'panels.stepMeta.toolServers.remedy.oauth_token_failed',
  },
  over_budget: {
    chip: 'panels.stepMeta.toolServers.reason.over_budget',
    remedy: 'panels.stepMeta.toolServers.remedy.over_budget',
  },
}

/** One server as the row renders it: wired, dropped for a reason this build knows, or dropped for
 *  one it does not. */
export type ToolServerRow =
  | { id: string; label: string; status: 'wired' }
  | { id: string; label: string; status: 'unavailable'; keys: ToolServerReasonPresentation }
  | { id: string; label: string; status: 'unavailable'; keys: null; rawReason: string }

/**
 * Project a step's recorded resolution into rows, wired first so the reader's eye lands on what
 * the agent HAD before what it did not.
 *
 * The third row shape is the reason this is a function rather than a template `v-for`. The reason
 * vocabulary is PERSISTED on the run, so a step recorded before a member was retired still arrives
 * here carrying it, and the exhaustive `Record` above (total against the TYPE) has no entry for
 * it. Narrowing through `isToolServerUnavailableReason` (derived from the picklist's own options,
 * so adding a member still fails the build until it has copy) is what lets that row say "this
 * build no longer recognises the reason, and here it is verbatim" instead of rendering an empty
 * chip or throwing inside the panel someone opened to read it.
 */
export function toolServerRows(servers: readonly DispatchedToolServer[]): ToolServerRow[] {
  const rows = servers.map((server): ToolServerRow => {
    if (server.status === 'wired') {
      return { id: server.id, label: server.label, status: 'wired' }
    }
    if (isToolServerUnavailableReason(server.reason)) {
      return {
        id: server.id,
        label: server.label,
        status: 'unavailable',
        keys: TOOL_SERVER_UNAVAILABLE_KEYS[server.reason],
      }
    }
    return {
      id: server.id,
      label: server.label,
      status: 'unavailable',
      keys: null,
      rawReason: String(server.reason ?? ''),
    }
  })
  return [
    ...rows.filter((row) => row.status === 'wired'),
    ...rows.filter((row) => row.status !== 'wired'),
  ]
}
