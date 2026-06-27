import {
  approveVisualConfirmContract,
  recaptureVisualConfirmContract,
  requestVisualConfirmFixContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The visual-confirmation gate's run-driving actions + the artifact helpers its window needs
 * (upload a reference design image, fetch a stored blob as an object URL). The action calls
 * return the updated execution instance (the gate state rides on its current step and also
 * arrives live via the execution stream). The blob/upload helpers use the authed `$fetch`
 * (the artifact ingest/blob endpoints are raw, not contract-modelled, because they carry binary).
 */
export function visualConfirmApi({ send, ws, http }: ApiContext) {
  return {
    // Approve the reviewed screenshots: advance the pipeline.
    approveVisualConfirm: (workspaceId: string, blockId: string) =>
      send(approveVisualConfirmContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Submit findings and request a fix (dispatches the Tester's fixer, then re-parks).
    requestVisualConfirmFix: (workspaceId: string, blockId: string, findings: string) =>
      send(requestVisualConfirmFixContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { findings },
      }),

    // Refresh the actual-vs-reference pairs from the latest UI-tester report.
    recaptureVisualConfirm: (workspaceId: string, blockId: string) =>
      send(recaptureVisualConfirmContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),

    // Upload a reference design image for a block (kind=reference), tagged with its view name.
    uploadReferenceArtifact: async (
      workspaceId: string,
      blockId: string,
      file: File,
      view: string,
    ): Promise<{ artifact: { id: string } }> => {
      const form = new FormData()
      form.append('file', file)
      form.append('kind', 'reference')
      form.append('blockId', blockId)
      if (view) form.append('view', view)
      return http(`${ws(workspaceId)}/artifacts`, { method: 'POST', body: form })
    },

    // Fetch a stored artifact's bytes and turn them into an object URL for an <img>.
    fetchArtifactBlobUrl: async (workspaceId: string, artifactId: string): Promise<string> => {
      const blob: Blob = await http(
        `${ws(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/blob`,
        { method: 'GET', responseType: 'blob' },
      )
      return URL.createObjectURL(blob)
    },
  }
}
