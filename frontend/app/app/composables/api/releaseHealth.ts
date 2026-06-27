import {
  deleteIncidentEnrichmentContract,
  deleteObservabilityConnectionContract,
  deleteReleaseHealthConfigContract,
  getIncidentEnrichmentContract,
  getObservabilityConnectionContract,
  listReleaseHealthConfigsContract,
  setIncidentEnrichmentContract,
  setObservabilityConnectionContract,
  upsertReleaseHealthConfigContract,
} from '@cat-factory/contracts'
import type {
  UpsertObservabilityConnectionInput,
  UpsertReleaseHealthConfigInput,
} from '~/types/releaseHealth'
import type { UpsertIncidentEnrichmentInput } from '~/types/incidentEnrichment'
import type { ApiContext } from './context'

/** Post-release-health: the observability connection + per-block monitor/SLO mapping. */
export function releaseHealthApi({ send, ws }: ApiContext) {
  return {
    // ---- Observability connection ------------------------------------------
    getObservabilityConnection: (workspaceId: string) =>
      send(getObservabilityConnectionContract, { pathPrefix: ws(workspaceId) }),

    setObservabilityConnection: (workspaceId: string, body: UpsertObservabilityConnectionInput) =>
      send(setObservabilityConnectionContract, { pathPrefix: ws(workspaceId), body }),

    deleteObservabilityConnection: (workspaceId: string) =>
      send(deleteObservabilityConnectionContract, { pathPrefix: ws(workspaceId) }),

    // ---- Per-block monitor/SLO config --------------------------------------
    listReleaseHealthConfigs: (workspaceId: string) =>
      send(listReleaseHealthConfigsContract, { pathPrefix: ws(workspaceId) }),

    upsertReleaseHealthConfig: (
      workspaceId: string,
      blockId: string,
      body: UpsertReleaseHealthConfigInput,
    ) =>
      send(upsertReleaseHealthConfigContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body,
      }),

    deleteReleaseHealthConfig: (workspaceId: string, blockId: string) =>
      send(deleteReleaseHealthConfigContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),

    // ---- Incident enrichment (PagerDuty + incident.io, write-only secrets) --
    getIncidentEnrichment: (workspaceId: string) =>
      send(getIncidentEnrichmentContract, { pathPrefix: ws(workspaceId) }),

    setIncidentEnrichment: (workspaceId: string, body: UpsertIncidentEnrichmentInput) =>
      send(setIncidentEnrichmentContract, { pathPrefix: ws(workspaceId), body }),

    deleteIncidentEnrichment: (workspaceId: string) =>
      send(deleteIncidentEnrichmentContract, { pathPrefix: ws(workspaceId) }),
  }
}
